// ───────────────────────────────────────────────────────────────────────────
// MP GAME SCREEN — the in-game multiplayer loop.
//
// Reuses the single-player renderer + in-game input UI, but:
//   - steps the sim on a FIXED dt (lockstep determinism; never wall-clock);
//   - processes local input ONLY on this client's turn;
//   - intercepts the human fire (the no-arg gs.fire() that keyboard/mouse/Launch all
//     reach) and routes it through LockstepSession.commitTurn, which broadcasts the
//     input and applies it (with an explicit tank arg, so it is NOT re-intercepted)
//     on every client;
//   - host-coordinates the round-end -> shop -> next-round transitions and runs the
//     shop window, so the match advances even if a player is idle.
//
// The between-round weapon shop is concurrent: every player shops their OWN tank
// locally, and the round advances ONLY when the host sees every human's cart
// (host-controlled all-done barrier). "Too long" is measured as INACTIVITY, not as
// a flat wall-clock window: per-client rAF clocks freeze whenever a browser window
// is occluded/backgrounded (Chrome pauses rAF; dt is clamped at main.ts step()), so
// with one human playing several browsers the old flat window expired on the host
// while the player was actively shopping in another window. Now a player only times
// out after shopSeconds with NO shop input (local auto-submit of the cart so far),
// the host independently fires the same idle rule from its own clock as a backstop
// for silent clients, and an absolute per-shop ceiling bounds adversarial stalling.
// All shop messages are round-tagged so carts/keepalives from one shop can never
// satisfy another shop's barrier (clients reach each shop at different real times).
// A transparent chat overlay (backquote) rides its own wire message and never
// touches the simulation, so players can talk while they wait -- or mid-round.
// ───────────────────────────────────────────────────────────────────────────
import * as pygame from "./pygame";
import * as W from "./widgets";
import * as ingame from "./ingame";
import * as ui from "./ui";
import * as talk from "./talk";
import { Screen } from "./screen";
import { ShopScreen, SellScreen, InventoryScreen } from "./screens";
import type { ScreenAction, ScreenEvent } from "./screen";
import { GameState, AIM, ROUND_END, SHOP, GAME_OVER } from "./game";
import { FIXED_DT } from "./net/sim_driver";
import { DEVICE_ID } from "./net/identity";
import { testHooks, PEER_DEAD_MS } from "./net/netconfig";
import type { LockstepSession, ShopResult } from "./net/lockstep";
import { ChatOverlay } from "./mp_chat";
import type { Role } from "./net/match";
import type { GameEngineAdapter } from "./net/engine_adapter";

export interface MpApp {
  renderer: { render(surf: pygame.Surface, gs: unknown): void };
  push(screen: unknown): void;
  pop(): void;
  keys(): { [code: number]: boolean };
  w: number;
  h: number;
}

const DEFAULT_SHOP_IDLE_SECONDS = 60; // shop auto-finishes after this much INACTIVITY (?shopSeconds)
const SHOP_GRACE_SECONDS = 2; // host allows this much extra for keepalives/carts in flight
const DEFAULT_SHOP_CEILING_SECONDS = 300; // absolute per-shop bound (?shopCeiling; anti-stall backstop)
const SHOP_ACT_INTERVAL_SECONDS = 2; // broadcast "still shopping" at most this often

/** Inputs to the host's shop barrier decision (all values on the HOST's clock). */
export interface ShopBarrierState {
  humans: readonly string[]; // human device ids in this match
  submitted: ReadonlySet<string>; // humans whose cart for THIS shop has arrived
  idleMsOf: (deviceId: string) => number; // ms since last shop sign-of-life
  idleLimitMs: number; // inactivity allowance (idle seconds + grace)
  elapsedS: number; // host wall-clock seconds in this shop
  ceilingS: number; // absolute per-shop bound
}

/** The host-controlled shop barrier. Fires ("advance the round") when:
 *    "all_in"  -- every human's cart is in (the normal case), or
 *    "idle"    -- every human still missing has been shop-inactive past the
 *                 allowance; being active in ANY seat keeps that seat waiting, so a
 *                 single person playing several browsers is never cut off, or
 *    "ceiling" -- the absolute per-shop bound elapsed (a client that streams
 *                 keepalives forever must not stall the match indefinitely).
 *  Returns null while the shop must keep waiting. Pure: unit-tested directly. */
export function shopBarrierReady(s: ShopBarrierState): "all_in" | "idle" | "ceiling" | null {
  if (s.humans.length === 0) return null; // nothing to wait for -> nothing to decide
  const pending = s.humans.filter((d) => !s.submitted.has(d));
  if (pending.length === 0) return "all_in";
  if (pending.every((d) => s.idleMsOf(d) > s.idleLimitMs)) return "idle";
  if (s.elapsedS >= s.ceilingS) return "ceiling";
  return null;
}
const DEFAULT_MAX_TURNS = 40; // host force-ends a round that runs this long (stalemate/AFK backstop)
const DEFAULT_TURN_SECONDS = 30; // a turn self-forfeits after this long idle at the OWN client's barrier
const TURN_WALL_FACTOR = 5; // host evicts a turn outliving this (x turnSeconds) wall-clock bound
const DROP_GRACE_SECONDS = 6; // a peer gone this long (past reconnect) ends the match
// Real-time sim pacing: the sim normally advances one FIXED_DT per rendered frame,
// but Chrome throttles/pauses rAF for unfocused or occluded windows, so that client
// plays flights in slow motion and reaches its lockstep barrier (minutes) late. Each
// frame we instead step the sim by the REAL elapsed time, bounded per frame.
const MAX_CATCHUP_STEPS = 120; // max sim steps per rendered frame (2 s of sim time)
const MAX_SIM_DEBT_S = 30; // forget backlog older than this (e.g. a long-hidden tab)
const CPU_OFFER_SECONDS = 25; // unanswered replace-with-computer prompt auto-declines

export class MpGameScreen extends Screen {
  override opaque = true;
  private readonly app: MpApp;
  private readonly session: LockstepSession;
  private readonly adapter: GameEngineAdapter;
  private readonly role: Role;
  private readonly isHost: boolean;
  private gsRef: GameState | null = null;
  private wrapped = false;
  private proceeded = false; // proceed_after_round done this round (deterministic, all clients)
  private forceEnded = false; // round force-ended this round (deterministic, all clients)
  // ── between-round shop (concurrent; host-controlled all-done barrier) ──
  private shopRound = -1; // round_index the current shop was initialized for
  private shopElapsed = 0; // local wall-clock in this shop (ceiling backstop only)
  private shopIdle = 0; // seconds since the LOCAL player last touched their open shop
  private shopActAge = 0; // seconds since the last "still shopping" broadcast
  private shopStack: Screen[] = []; // local shop UI (ShopScreen + Sell/Inventory sub-screens)
  private shopDone = false; // local player finished shopping (clicked Done or idled out)
  private shopSubmitted = false; // local cart broadcast/recorded this shop
  private shopfinApplied = false; // authoritative outcome applied -> advanced to next round
  // Latest cart per device, tagged with the shop round it belongs to. NOT cleared
  // between shops: a cart for shop N can arrive while this client is still
  // animating round N's end, i.e. before its own shop N initializes.
  private shopCarts = new Map<string, ShopResult & { round: number }>();
  private preShop = new Map<string, ShopResult>(); // host: deviceId -> pre-shop state
  private hostLastActMs = new Map<string, number>(); // host: deviceId -> last sign of shopping life
  private pendingShopFinal: { round: number; results: Record<string, ShopResult> } | null = null;
  // ── chat overlay (transparent; shared with the lobby, so the pre-match
  //    conversation carries into the game; never touches the sim) ──
  private readonly chat: ChatOverlay;
  private banner = "";
  private readonly shopSeconds: number;
  private readonly shopCeiling: number;
  private readonly maxTurns: number;
  private readonly turnSeconds: number;
  private turnsThisRound = 0;
  private lastRound = -1;
  private lastShooter: unknown = null;
  private turnElapsed = 0; // time on the current AIM turn (host holds it while the active peer catches up)
  private turnWall = 0; // wall-clock on the current AIM turn (absolute TURN_WALL_FACTOR bound)
  private turnForfeited = false;
  private lastRealMs: number | null = null; // real-time sim pacing (rAF-independent)
  private simDebt = 0; // real seconds the sim still owes (catch-up backlog)
  private desyncNote = ""; // non-empty once the host flagged a divergence (shown in red)
  // ── CPU replacement of departed players (host decision) ──
  private cpuOffer: { deviceId: string; name: string; age: number } | null = null; // pending Y/N prompt
  private cpuReplace = new Set<string>(); // host said YES: convert at their next turn
  private cpuDecided = new Set<string>(); // prompted already (yes OR no): never re-prompt
  private startCount = 0; // roster size at match start (disconnect detection)
  private droppedFor = 0; // real-time a player has been disconnected
  private aborted = ""; // non-empty => match ended (e.g., a player left)
  private overQuote: readonly [string, string] | null = null; // game-over war quote, picked once

  constructor(app: MpApp, session: LockstepSession, adapter: GameEngineAdapter, role: Role, chat: ChatOverlay) {
    super();
    this.app = app;
    this.session = session;
    this.adapter = adapter;
    this.role = role;
    this.chat = chat; // owned/wired by the lobby (session.onChat feeds it there)
    this.isHost = role === "host";
    const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
    this.shopSeconds = Number(params.get("shopSeconds")) || DEFAULT_SHOP_IDLE_SECONDS;
    this.shopCeiling = Number(params.get("shopCeiling")) || DEFAULT_SHOP_CEILING_SECONDS;
    this.maxTurns = Number(params.get("maxTurns")) || DEFAULT_MAX_TURNS;
    this.turnSeconds = Number(params.get("turnSeconds")) || DEFAULT_TURN_SECONDS;
    // No onControl handler: round-end and force-end are deterministic on every
    // client (no message), the shop barrier rides its own host-authoritative
    // shopfin, and EVERY forfeit (turn-timeout self-forfeit AND the host's
    // dead/stuck-client eviction) rides the numbered turn pipeline as a retreat
    // turn, so it is ordered and applied at each client's own AIM barrier exactly
    // like a shot. The old ctrl-"forfeit" was applied only if the receiver happened
    // to be at AIM ON ARRIVAL -- a client still animating the previous flight
    // silently DROPPED it and permanently desynced (host in the next round/shop,
    // laggard stuck waiting).
    // Surface detected desyncs in-game (they were previously logged only in the
    // lobby lines, i.e. invisible during a match). Chain the lobby's handler --
    // it keeps the __mpDesyncs test telemetry.
    const prevDesync = this.session.onDesync;
    this.session.onDesync = (n, peer) => {
      prevDesync?.(n, peer);
      this.desyncNote = `SYNC LOST (turn ${n}): clients diverged`;
    };
    // Every client records carts (drives the "waiting for ..." display); the host's
    // copy is also the authoritative aggregation. A cart doubles as a sign of life.
    // Guests stash the authoritative outcome and apply it in the update loop (not in
    // this network callback).
    this.session.onShopResult = (deviceId, round, inv, cash) => {
      this.shopCarts.set(deviceId, { round, inv, cash });
      if (this.isHost) this.hostLastActMs.set(deviceId, Date.now());
    };
    this.session.onShopActivity = (deviceId, round) => {
      if (this.isHost && round === this.shopRound) this.hostLastActMs.set(deviceId, Date.now());
    };
    this.session.onShopFinal = (round, results) => {
      if (!this.isHost) this.pendingShopFinal = { round, results };
    };
    // Test hook (harness only, ?test=1): commit an rng-free aimed shot on this
    // client's turn. NEVER exposed in production -- it would be a console auto-fire
    // cheat. (Calling the engine AI would draw rng on only the active client and
    // desync; this computes the aim in plain JS so every client applies the same input.)
    if (testHooks()) {
      const g = globalThis as Record<string, unknown>;
      g.__mpAutoFire = () => this._autoFire();
      // Shop-replication harness (?test=1 only): buy on the local tank (cash granted so
      // the purchase is always possible -- we are testing replication, not the economy)
      // and finish shopping. The result rides the normal shopfin path to every client.
      g.__mpShopBuy = (slot: number): boolean => {
        const gs = this.adapter.state();
        if (!gs || gs.phase !== SHOP) return false;
        const t = this.adapter.tankOf(DEVICE_ID) as { cash: number } | null;
        if (!t) return false;
        t.cash += 1_000_000;
        return (gs as unknown as { economy: { buy(tk: unknown, s: number): boolean } }).economy.buy(t, slot);
      };
      g.__mpShopDone = (): boolean => {
        if (this.adapter.state()?.phase !== SHOP) return false;
        this._submitLocalCart(true);
        return true;
      };
      // Simulate a divergent/cheating client: perturb local state so this client's next
      // worldHash differs from the others, which the host must DETECT (onDesync). Used to
      // prove the desync detector fires (every passing test otherwise shows 0 desyncs).
      g.__mpDesync = (): boolean => {
        const gs = this.adapter.state();
        const t0 = gs?.tanks?.[0] as { health: number; x: number } | undefined;
        if (!t0) return false;
        if (t0.health > 1) t0.health -= 1;
        else t0.x += 3;
        return true;
      };
    }
  }

  /** FNV-1a over every tank's inventory -- a cross-client inventory-convergence probe
   *  (worldHash deliberately omits inventory). Test telemetry only. */
  private _invHash(gs: GameState): string {
    let h = 0x811c9dc5;
    for (const t of gs.tanks as Array<{ inventory: number[] }>) {
      for (const v of t.inventory) {
        h ^= v & 0xff;
        h = Math.imul(h, 0x01000193);
      }
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  private _autoFire(): boolean {
    const gs = this.adapter.state();
    if (!gs || gs.phase !== AIM || !this._isMyTurn()) return false;
    const t = gs.current_shooter as { x: number; selected_weapon: number; alive: boolean } | null;
    if (!t) return false;
    let target: { x: number } | null = null;
    let bestD = Infinity;
    for (const o of gs.tanks as Array<{ x: number; alive: boolean }>) {
      if (o === (t as unknown) || !o.alive) continue;
      const d = Math.abs(o.x - t.x);
      if (d < bestD) { bestD = d; target = o; }
    }
    let angle = 45;
    let power = 600;
    if (target) {
      const dx = target.x - t.x;
      angle = dx >= 0 ? 42 : 138; // lob toward the target's side
      power = Math.max(250, Math.min(1000, Math.round(Math.abs(dx) * 1.4 + 150)));
    }
    this.session.commitTurn({ angle, power, weapon: t.selected_weapon, moves: [] });
    return true;
  }

  /** Wrap gs.fire once so the LOCAL human fire (no-arg, my AIM turn) becomes a
   *  lockstep commit. The adapter/AI always fire with an explicit tank, so they pass
   *  straight through. */
  private _wireFire(gs: GameState): void {
    if (this.wrapped) return;
    this.wrapped = true;
    const realFire = gs.fire.bind(gs);
    const self = this;
    (gs as unknown as { fire: (s?: unknown) => unknown[] }).fire = function (shooter?: unknown): unknown[] {
      if ((shooter === undefined || shooter === null) && gs.phase === AIM && self._isMyTurn()) {
        const t = gs.current_shooter as { angle: number; power: number; selected_weapon: number } | null;
        if (t) {
          self.session.commitTurn({ angle: t.angle, power: t.power, weapon: t.selected_weapon, moves: [] });
        }
        return []; // commit -> applied on all clients via the adapter (explicit-arg fire)
      }
      return realFire(shooter as never) as unknown[];
    };
  }

  private _isMyTurn(): boolean {
    return this.adapter.activeDeviceId() === DEVICE_ID;
  }

  override handle(event: ScreenEvent): ScreenAction {
    const gs = this.adapter.state();
    if (!gs) return null;
    if (this.aborted || gs.phase === GAME_OVER) {
      if (event.type === pygame.KEYDOWN || event.type === pygame.MOUSEBUTTONDOWN) {
        this.session.match.leave();
        this.app.pop();
        return "to_menu";
      }
      return null;
    }
    // Chat input is modal: while the compose box is open it captures EVERY key
    // (Esc cancels, Enter sends, Backspace edits, printable chars append), so chat
    // can never collide with aim keys (Space/Enter fire!) or shop accelerators.
    if (this.chat.open && event.type === pygame.KEYDOWN) {
      // Typing chat is being at the keyboard: while the local shop is open it also
      // counts as shop activity, so composing a line can't idle a shopper out.
      if (gs.phase === SHOP && this.shopStack.length > 0) this._noteShopActivity();
      this.chat.handleKey(event);
      return null;
    }
    // Backquote opens chat anywhere in the match (aim, flight, shop, waiting).
    // The key is otherwise unused by the engine (Enter fires, 't' is the control
    // panel, Tab cycles weapons -- all unavailable).
    if (event.type === pygame.KEYDOWN && event.key === pygame.K_BACKQUOTE) {
      if (gs.phase === SHOP && this.shopStack.length > 0) this._noteShopActivity();
      this.chat.open = true;
      return null;
    }
    // Host prompt: a player disconnected -- replace their tank with a computer?
    if (this.cpuOffer && event.type === pygame.KEYDOWN) {
      if (event.key === pygame.K_y) {
        this.cpuReplace.add(this.cpuOffer.deviceId);
        this.cpuDecided.add(this.cpuOffer.deviceId);
        this.cpuOffer = null;
        return null;
      }
      if (event.key === pygame.K_n) {
        this.cpuDecided.add(this.cpuOffer.deviceId);
        this.cpuOffer = null;
        return null;
      }
      // other keys fall through (the prompt is not modal; the host can keep playing)
    }
    // While the local shop is open it takes all input (until ~Done or idle-out);
    // Esc inside the shop must not leave the match.
    if (gs.phase === SHOP && this.shopStack.length > 0) {
      return this._handleShop(event);
    }
    // Esc leaves the match (the only in-game exit short of closing the tab); leaving
    // disconnects, which ends the match for the others via the drop detector.
    if (event.type === pygame.KEYDOWN && event.key === pygame.K_ESCAPE) {
      this.session.match.leave();
      this.app.pop();
      return "to_menu";
    }
    // Tank movement is not replicated in MP (no fuel is granted and applyTurnInput
    // carries no moves), so block the fuel-move sub-mode outright: a tank that drove
    // would desync every other client. Remove when moves are replicated (see M4).
    if (event.type === pygame.KEYDOWN && event.key === pygame.K_f) return null;
    // Only the active local player drives the aim/fire UI (else we'd aim someone
    // else's tank). ingame reaches gs.fire(), which our wrapper intercepts.
    if (this._isMyTurn()) {
      ingame.handle_game_event(gs as never, event as never);
    }
    return null;
  }

  override update(dt: number): ScreenAction {
    this.chat.tick(dt); // overlay clock (line fading); independent of the sim
    const gs = this.adapter.state();
    if (!gs) return null;
    this.gsRef = gs;
    this._wireFire(gs);

    if (this._isMyTurn() && gs.phase === AIM) {
      ingame.update_game_input(gs as never, dt, this.app.keys());
    }

    // Step the simulation by REAL elapsed time (bounded), not one step per rendered
    // frame: Chrome throttles/pauses rAF for unfocused windows, and the app clock
    // clamps dt to 1/30 s, so a backgrounded client otherwise crawls through the
    // flight in slow motion and reaches its lockstep barrier minutes late. Sim
    // determinism is untouched -- every client walks the SAME fixed-dt step
    // sequence, catch-up only changes how fast it walks. _trackTurns runs per step
    // so the deterministic turn-cap counts every shooter change even inside a
    // burst, and tryPump runs per step so a burst crosses turn barriers.
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    const realDt = this.lastRealMs === null ? dt : (nowMs - this.lastRealMs) / 1000;
    this.lastRealMs = nowMs;
    this.simDebt = Math.min(this.simDebt + Math.max(realDt, 0), MAX_SIM_DEBT_S);
    // 0 steps on a fast frame is correct (a 120 Hz display no longer runs 2x).
    const steps = Math.min(Math.floor(this.simDebt / FIXED_DT), MAX_CATCHUP_STEPS);
    for (let i = 0; i < steps; i++) {
      (gs as unknown as { update(dt: number): void }).update(FIXED_DT);
      this.simDebt = Math.max(0, this.simDebt - FIXED_DT);
      this._trackTurns(gs);
      // At the AIM barrier (previous flight resolved), apply the next buffered turn
      // -- the lockstep frame-sync that keeps clients converged. Pumping also on OUR
      // OWN turn is how a host retreat-turn committed on our behalf (dead/stuck
      // eviction) reaches us; a real opponent turn can never match there (the
      // per-sender rule keys it to the active player, i.e. us, and we don't message
      // ourselves).
      if (gs.phase === AIM) this.session.tryPump();
      // Stop bursting at interactive/coordinated points: our own aim turn runs in
      // real time, and ROUND_END/SHOP/GAME_OVER are driven per frame by _coordinate.
      const p = gs.phase as string;
      if ((p === AIM && this._isMyTurn()) || p === ROUND_END || p === SHOP || p === GAME_OVER) break;
    }
    // At an interactive/coordinated point there is nothing to catch up to.
    if (gs.phase === SHOP || gs.phase === GAME_OVER || (gs.phase === AIM && this._isMyTurn())) this.simDebt = 0;
    this._coordinate(gs, dt);
    this._realtimeGuards(gs, dt);
    // Drive the local shop UI's own animation (palette cycle) while it is open.
    if (this.shopStack.length > 0) this.shopStack[this.shopStack.length - 1].update(dt);
    // test telemetry (harness only, ?test=1)
    if (testHooks()) (globalThis as Record<string, unknown>).__mpGame = {
      phase: gs.phase,
      round: gs.round_index,
      myTurn: this._isMyTurn(),
      over: gs.phase === GAME_OVER,
      winner: gs.winner ? gs.winner.name : null,
      hash: this.adapter.worldHash(),
      inv: this._invHash(gs),
      shopping: this.shopStack.length > 0,
      shopIdle: Math.round(this.shopIdle * 10) / 10,
      waitingFor: gs.phase === SHOP ? this._pendingNames() : [],
      chatCount: this.chat.count(),
      chatLast: this.chat.last(),
      cpuOffer: this.cpuOffer ? this.cpuOffer.name : null,
      aiTanks: gs.tanks.filter((t) => (t as unknown as { ai_class: number }).ai_class !== 0).length,
      desync: this.desyncNote !== "",
      aborted: this.aborted,
      alive: gs.tanks.filter((t) => t.alive).length,
    };
    return null;
  }

  /** Count turns per round and let the host bound a round that never resolves
   *  (stalemate / AFK). All per-round coordination flags reset on a round change. */
  private _trackTurns(gs: GameState): void {
    if (gs.round_index !== this.lastRound) {
      this.lastRound = gs.round_index;
      this.turnsThisRound = 0;
      this.lastShooter = null;
      this.forceEnded = false;
      this.proceeded = false;
    }
    if (gs.phase === AIM) {
      const cs = gs.current_shooter as unknown;
      if (cs && cs !== this.lastShooter) {
        this.lastShooter = cs;
        this.turnsThisRound++;
        this.turnElapsed = 0; // new turn -> reset the host turn-timeout clock
        this.turnWall = 0;
        this.turnForfeited = false;
      }
      // Deterministic round bound: identical synced turn count on every client, so
      // each force-ends the round at the same point with NO message.
      if (!this.forceEnded && this.turnsThisRound > this.maxTurns) {
        this.forceEnded = true;
        gs.mass_kill();
      }
    }
  }

  /** Wall-clock-driven guards (host turn-timeout forfeit + disconnect detection).
   *  These are real-time decisions, so the host drives the forfeit (broadcast) and
   *  every client independently watches its own roster for a dropped player. */
  private _realtimeGuards(gs: GameState, dt: number): void {
    if (this.aborted || gs.phase === GAME_OVER) return;
    const players = this.session.match.players();
    // A peer counts as present only if the ICE layer says connected AND a datachannel
    // frame arrived recently. The second clause is the dead-peer detection: it catches a
    // peer whose RTCPeerConnection still reads "connected" but has gone silent (wedged
    // tab, frozen JS, black-holed path) before ICE consent-freshness notices.
    const connected = players.filter(
      (p) => p.deviceId === DEVICE_ID || (p.connected && this.session.match.msSinceHeard(p.deviceId) <= PEER_DEAD_MS),
    ).length;
    if (this.startCount === 0 && connected >= 2) this.startCount = connected;
    // Host: offer to replace a departed player's tank with a computer (once per
    // player). Silent past PEER_DEAD_MS = gone (closed tab / dead network); merely
    // slow/backgrounded windows keep heartbeating and never trip this.
    if (this.isHost && !this.cpuOffer) {
      for (const d of this.adapter.humanDeviceIds()) {
        if (d === DEVICE_ID || this.cpuDecided.has(d)) continue;
        if (this.session.match.msSinceHeard(d) > PEER_DEAD_MS) {
          this.cpuOffer = { deviceId: d, name: this._nameOf(d), age: 0 };
          break;
        }
      }
    }
    // An unanswered offer auto-declines so it can never park the match forever
    // (the abort countdown below is held while an offer/approval is pending).
    if (this.cpuOffer) {
      this.cpuOffer.age += dt;
      if (this.cpuOffer.age > CPU_OFFER_SECONDS) {
        this.cpuDecided.add(this.cpuOffer.deviceId);
        this.cpuOffer = null;
      }
    }
    // End the match only when you are the last one connected AND no computer tank
    // keeps it meaningful; a 3+ player match keeps going (1v1) after a single drop,
    // and a match with CPU opponents (lobby-added or a replaced leaver) plays on.
    // A pending offer or approved-but-not-yet-applied replacement also holds the
    // abort: the conversion can only apply at the departed player's next turn,
    // which can be a full flight away.
    const hasCpu = gs.tanks.some((t) => (t as unknown as { ai_class: number }).ai_class !== 0); // C.AI_HUMAN
    const cpuPending = this.cpuOffer !== null || this.cpuReplace.size > 0;
    if (this.startCount >= 2 && connected < 2 && !hasCpu && !cpuPending) {
      this.droppedFor += dt;
      if (this.droppedFor > DROP_GRACE_SECONDS) this.aborted = "You are the last player connected.";
    } else {
      this.droppedFor = 0;
    }
    // Every client advances the turn clock so the ACTIVE player sees their own
    // countdown. Forfeits are RETREAT TURNS through the numbered pipeline:
    //   - Turn timeout is SELF-enforced: the active player's own client commits the
    //     retreat when ITS clock expires. Its clock starts when ITS sim reaches the
    //     turn, so a slow/backgrounded client is never forfeited for being late --
    //     only for being idle at its own barrier. (The old host-side wall clock
    //     forfeited players who were still animating the previous flight; with 2
    //     players that retreat ended the round and dumped the host in the shop.)
    //   - The HOST evicts only a DEAD (transport-silent past PEER_DEAD_MS; merely
    //     throttled windows keep heartbeating) or STUCK (turnWall: alive but never
    //     advancing) active player, by committing the retreat on their behalf
    //     (tryPump accepts a host stand-in for retreat turns only). If the victim
    //     revives and fires in the same instant, the numbered pipeline rejects the
    //     loser of the race and the hash check flags the divergence.
    if (gs.phase === AIM && !this.turnForfeited) {
      this.turnElapsed += dt;
      this.turnWall += dt;
      const retreatTurn = { angle: 0, power: 0, weapon: 0, moves: [], retreat: true };
      if (this._isMyTurn()) {
        if (this.turnElapsed > this.turnSeconds) {
          this.turnForfeited = true;
          this.session.commitTurn(retreatTurn);
        }
      } else if (this.isHost) {
        const activeId = this.adapter.activeDeviceId();
        // humanDeviceIds guard: an AI slot has a deviceId but no peer, so
        // msSinceHeard would read Infinity and instantly evict an AI turn.
        const activeRemoteHuman = activeId !== null && this.adapter.humanDeviceIds().includes(activeId);
        const activeDead = activeRemoteHuman && this.session.match.msSinceHeard(activeId) > PEER_DEAD_MS;
        if (activeDead || this.turnWall > this.turnSeconds * TURN_WALL_FACTOR) {
          this.turnForfeited = true;
          // If the host approved CPU replacement for this departed player, convert
          // their tank as part of the eviction. This is the ONE race-free moment:
          // the victim is the active player and is dead, so no client can commit a
          // competing turn while the host stands in.
          const idx = activeId !== null ? this.adapter.deviceIds().indexOf(activeId) : -1;
          if (activeId !== null && idx >= 0 && this.cpuReplace.has(activeId)) {
            this.cpuReplace.delete(activeId);
            this.session.commitTurn({ ...retreatTurn, convert: { tank: idx, aiClass: 8 } }); // AI_UNKNOWN
          } else {
            this.session.commitTurn(retreatTurn);
          }
        }
      }
    }
  }

  /** Host-driven round progression; the shop has its own barrier (_coordinateShop). */
  private _coordinate(gs: GameState, dt: number): void {
    if (gs.phase === ROUND_END) {
      this.banner = `Round ${gs.round_index} over`;
      if (!this.proceeded) {
        this.proceeded = true;
        gs.proceed_after_round(); // deterministic on every client at ROUND_END (-> SHOP or GAME_OVER)
      }
    } else if (gs.phase === SHOP) {
      this._coordinateShop(gs, dt);
    } else {
      this.banner = "";
    }
  }

  /** Between-round shop: all humans shop CONCURRENTLY, each on their own tank, and
   *  the round advances only at the host-controlled barrier: every human's cart is
   *  in, OR every missing human has shown no shop activity for shopSeconds(+grace),
   *  OR the absolute ceiling elapsed (anti-stall backstop). The host then broadcasts
   *  one authoritative post-shop snapshot of every human tank and every client
   *  applies it before begin_next_round, so message ordering can't desync the
   *  inventories. An idle player auto-submits whatever is in their cart so far. */
  private _coordinateShop(gs: GameState, dt: number): void {
    if (this.shopRound !== gs.round_index) {
      // First frame of this shop: reset the per-shop state. shopCarts is kept --
      // carts are round-tagged and one for THIS shop may already have arrived.
      this.shopRound = gs.round_index;
      this.shopElapsed = 0;
      this.shopIdle = 0;
      this.shopActAge = SHOP_ACT_INTERVAL_SECONDS; // first activity broadcasts immediately
      this.shopDone = false;
      this.shopSubmitted = false;
      this.shopfinApplied = false;
      this.shopStack = [];
      this.preShop.clear();
      this.hostLastActMs.clear();
      if (this.isHost) {
        const now = Date.now();
        for (const d of this.adapter.humanDeviceIds()) {
          this.hostLastActMs.set(d, now); // every idle clock starts at shop open
          const s = this.adapter.shopSnapshot(d);
          if (s) this.preShop.set(d, s);
        }
      }
    }
    this.banner = "";
    if (this.shopfinApplied) return; // already advanced to the next round on this client

    // Guest: apply the host's authoritative outcome for THIS shop once it arrives.
    if (!this.isHost && this.pendingShopFinal && this.pendingShopFinal.round === this.shopRound) {
      this._applyShopFinal(this.pendingShopFinal.results);
      this.pendingShopFinal = null;
      return;
    }

    // Open the local shop for a human local player (once, until they finish).
    const myTank = this.adapter.tankOf(DEVICE_ID) as { ai_class: number } | null;
    const iAmHuman = !!myTank && myTank.ai_class === 0; // C.AI_HUMAN
    if (iAmHuman && !this.shopDone && this.shopStack.length === 0) {
      this.shopStack.push(new ShopScreen(gs as never, myTank as never, this.app.w, this.app.h) as unknown as Screen);
    }

    this.shopElapsed += dt;
    this.shopIdle += dt;
    this.shopActAge += dt;
    // Local inactivity auto-finish: submit the cart as it stands (purchases so far
    // are KEPT). An active player never times out -- _noteShopActivity resets the
    // clock on every shop input. A non-human local slot has nothing to shop, so it
    // finalizes immediately and never blocks the barrier.
    if (!this.shopSubmitted && (this.shopIdle >= this.shopSeconds || !iAmHuman)) {
      this._submitLocalCart(iAmHuman);
    }

    // Host barrier (see shopBarrierReady for the exact rule).
    if (this.isHost) {
      const humans = this.adapter.humanDeviceIds();
      const now = Date.now();
      const why = shopBarrierReady({
        humans,
        submitted: new Set(humans.filter((d) => this.shopCarts.get(d)?.round === this.shopRound)),
        idleMsOf: (d) => now - (this.hostLastActMs.get(d) ?? now),
        idleLimitMs: (this.shopSeconds + SHOP_GRACE_SECONDS) * 1000,
        elapsedS: this.shopElapsed,
        ceilingS: this.shopCeiling,
      });
      if (why) {
        const results: Record<string, ShopResult> = {};
        for (const d of humans) {
          const cart = this.shopCarts.get(d);
          const r = cart && cart.round === this.shopRound ? { inv: cart.inv, cash: cart.cash } : this.preShop.get(d);
          if (r) results[d] = r;
        }
        this.session.sendShopFinal(this.shopRound, results);
        this._applyShopFinal(results);
      }
    }
  }

  /** Finalize the local player's purchases: snapshot inventory+cash, record + broadcast
   *  the cart (every client shows who is done; the host aggregates authoritatively),
   *  and close the shop UI. Idempotent per shop. */
  private _submitLocalCart(iAmHuman: boolean): void {
    if (this.shopSubmitted) return;
    this.shopSubmitted = true;
    this.shopDone = true;
    this.shopStack = [];
    if (!iAmHuman) return;
    const snap = this.adapter.shopSnapshot(DEVICE_ID);
    if (!snap) return;
    this.shopCarts.set(DEVICE_ID, { round: this.shopRound, inv: snap.inv, cash: snap.cash });
    this.session.sendShop(this.shopRound, snap.inv, snap.cash);
    if (this.isHost) this.hostLastActMs.set(DEVICE_ID, Date.now());
  }

  /** Local shop input: reset the idle clock; guests also (throttled) broadcast a
   *  "still shopping" keepalive so the host's independent idle rule stays fresh. */
  private _noteShopActivity(): void {
    this.shopIdle = 0;
    if (this.isHost) {
      this.hostLastActMs.set(DEVICE_ID, Date.now());
    } else if (this.shopActAge >= SHOP_ACT_INTERVAL_SECONDS) {
      this.shopActAge = 0;
      this.session.sendShopActivity(this.shopRound);
    }
  }

  /** Humans whose cart for the CURRENT shop has not been seen locally (display). */
  private _pendingNames(): string[] {
    return this.adapter
      .humanDeviceIds()
      .filter((d) => this.shopCarts.get(d)?.round !== this.shopRound)
      .map((d) => this._nameOf(d));
  }

  private _nameOf(deviceId: string): string {
    const p = this.session.match.players().find((q) => q.deviceId === deviceId);
    return p ? p.name : deviceId.slice(0, 6);
  }

  /** Top-center notices: the host's CPU-replacement prompt and a detected desync.
   *  Drawn over gameplay AND the shop (below the engine HUD). */
  private _drawNotices(surf: pygame.Surface): void {
    let y = 46;
    const note = (msg: string, color: [number, number, number]): void => {
      const f = W.font(16, true);
      const r = f.render(msg, true, color);
      const x = Math.trunc((this.app.w - r.get_width()) / 2);
      const ov = new pygame.Surface([r.get_width() + 16, r.get_height() + 10], pygame.SRCALPHA);
      ov.fill([0, 0, 0, 130]);
      surf.blit(ov, [x - 8, y - 5]);
      surf.blit(r, [x, y]);
      y += r.get_height() + 14;
    };
    if (this.cpuOffer) note(`${this.cpuOffer.name} disconnected -- Y: replace with computer  N: don't`, [255, 210, 120]);
    if (this.desyncNote) note(this.desyncNote, [255, 120, 110]);
  }

  private _drawChat(surf: pygame.Surface): void {
    this.chat.draw(surf, this.app.w, this.app.h);
  }

  /** Apply the host's authoritative post-shop state to every human tank, then resolve
   *  the round (run_ai_buys + begin_next_round). Runs identically on every client. */
  private _applyShopFinal(results: Record<string, ShopResult>): void {
    if (this.shopfinApplied) return;
    this.shopfinApplied = true;
    for (const d of this.adapter.humanDeviceIds()) {
      const r = results[d];
      if (r) this.adapter.applyShopSnapshot(d, r);
    }
    this.adapter.finishShop(); // run_ai_buys + begin_next_round (deterministic everywhere)
  }

  /** Drive the local shop mini-stack (ShopScreen + Sell/Inventory sub-screens). Kept
   *  inside this screen because the app stack only updates the TOP screen, so a shop
   *  pushed there would freeze the netcode loop. Done (~pop on the root) finalizes. */
  private _handleShop(event: ScreenEvent): ScreenAction {
    const gs = this.adapter.state();
    const top = this.shopStack[this.shopStack.length - 1];
    if (!gs || !top) return null;
    // Any interaction with the open shop is activity: reset the local idle clock and
    // (throttled) tell the host this player is still shopping, so an actively buying
    // player is never timed out from either side.
    if (event.type === pygame.KEYDOWN || event.type === pygame.MOUSEBUTTONDOWN || event.type === pygame.MOUSEMOTION) {
      this._noteShopActivity();
    }
    const a = top.handle(event);
    if (a === "pop") {
      if (this.shopStack.length > 1) this.shopStack.pop();
      else this._submitLocalCart(true); // ~Done on the root shop screen
    } else if (a === "push:sell") {
      const slot = (top as unknown as { sell_slot?: number | null }).sell_slot;
      const tank = this.adapter.tankOf(DEVICE_ID);
      if (slot !== undefined && slot !== null && tank) {
        this.shopStack.push(new SellScreen(gs as never, tank as never, slot, this.app.w, this.app.h) as unknown as Screen);
      }
    } else if (a === "shop_inventory") {
      const tank = this.adapter.tankOf(DEVICE_ID);
      if (tank) this.shopStack.push(new InventoryScreen(gs as never, tank as never, this.app.w, this.app.h) as unknown as Screen);
    }
    return null;
  }

  override draw(surf: pygame.Surface): void {
    const gs = this.gsRef ?? this.adapter.state();
    if (!gs) {
      surf.fill(W.C_BG);
      return;
    }
    this.app.renderer.render(surf, gs as never);
    this._overlay(surf, gs);
  }

  /** MP status overlay. Drawn along the BOTTOM so it never collides with the engine
   *  HUD (power/angle/name/weapon/wind) along the top. */
  private _overlay(surf: pygame.Surface, gs: GameState): void {
    const big = W.font(40, true);
    const f = W.font(16, true);
    const fs = W.font(14, false);
    const center = (r: pygame.Surface, y: number) =>
      surf.blit(r, [Math.trunc((this.app.w - r.get_width()) / 2), y]);

    if (this.aborted) {
      center(big.render("Match ended", true, [255, 140, 120]), Math.trunc(this.app.h / 2) - 40);
      center(fs.render(`${this.aborted}  press any key for the menu.`, true, [235, 235, 235]), Math.trunc(this.app.h / 2) + 14);
      return;
    }
    if (gs.phase === GAME_OVER) {
      // Final scoring in the original's grey rankings panel (war quote picked once).
      if (!this.overQuote) this.overQuote = talk.war_quote(gs.rng as never);
      const title = gs.winner ? "Final Scoring" : "No Winner";
      ui.draw_rankings(surf, this.app.renderer as never, gs as never, title, null, this.overQuote as [string, string]);
      center(fs.render("press any key to return to the menu", true, [235, 235, 235]), this.app.h - 40);
      return;
    }
    if (gs.phase === SHOP) {
      if (this.shopStack.length > 0) {
        // Local shop is open: draw it (its screens are opaque). No global countdown --
        // an ACTIVE shopper is never timed out. Only warn once the idle clock nears
        // the local auto-finish.
        for (const s of this.shopStack) s.draw(surf);
        const idleLeft = Math.ceil(this.shopSeconds - this.shopIdle);
        const msg =
          idleLeft <= 15
            ? `idle -- shop auto-finishes in ${Math.max(0, idleLeft)}s (any input resets)`
            : "~Done to finish  -  ` to chat";
        center(fs.render(msg, true, idleLeft <= 15 ? [255, 180, 120] : [235, 235, 235]), this.app.h - 22);
        this._drawChat(surf);
        this._drawNotices(surf);
        return;
      }
      // Shopping done (or no shop for me): standings while the others finish. The
      // round advances when everyone is done (host-controlled), NOT on a countdown.
      const remain = Math.max(0, ((gs.cfg as { MAXROUNDS?: number }).MAXROUNDS ?? 0) - gs.round_index);
      ui.draw_rankings(surf, this.app.renderer as never, gs as never, "Standings", remain);
      const pending = this._pendingNames();
      const msg = pending.length > 0 ? `waiting for ${pending.join(", ")}  -  \` to chat` : "starting next round...";
      center(fs.render(msg, true, [235, 235, 235]), this.app.h - 40);
      this._drawConnSummary(surf, fs);
      this._drawChat(surf);
      this._drawNotices(surf);
      return;
    }

    const by = this.app.h - 44;
    const mine = this._isMyTurn();
    const turnTxt = mine ? "YOUR TURN" : `waiting for ${(gs.current_shooter as { name?: string } | null)?.name ?? "..."}`;
    surf.blit(f.render(turnTxt, true, mine ? [120, 255, 140] : [230, 230, 140]), [12, by]);
    if (this.banner) surf.blit(fs.render(this.banner, true, [180, 220, 255]), [12, by + 22]);
    // Turn countdown shown to EVERY client (the active player most needs it; the host
    // remains the authority that actually forfeits).
    if (gs.phase === AIM) {
      const left = Math.max(0, Math.ceil(this.turnSeconds - this.turnElapsed));
      surf.blit(fs.render(`turn ${left}s`, true, left <= 5 ? [255, 160, 120] : [200, 200, 200]), [12, by - 20]);
    }
    this._drawConnSummary(surf, fs);
    this._drawChat(surf); // chat rides over gameplay too (backquote to talk)
    this._drawNotices(surf);
  }

  /** bottom-right: live connection summary (the "connection info during the match"). */
  private _drawConnSummary(surf: pygame.Surface, fs: pygame.Font): void {
    const players = this.session.match.players();
    const conn = players.filter((p) => p.connected || p.deviceId === DEVICE_ID).length;
    const cr = fs.render(`players ${conn}/${players.length}`, true, conn >= players.length ? [140, 230, 160] : [255, 180, 120]);
    surf.blit(cr, [this.app.w - cr.get_width() - 12, this.app.h - 24]);
  }
}
