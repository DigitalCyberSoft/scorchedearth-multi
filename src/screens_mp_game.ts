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
// The between-round weapon shop is a flat timed window (default 60s): each player
// shops their OWN tank locally, and at the barrier (all done, or the window elapses)
// the host broadcasts one authoritative snapshot of every human tank's inventory so
// every client converges before begin_next_round (see _coordinateShop). Idle past the
// window => you get nothing.
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
import { testHooks } from "./net/netconfig";
import type { LockstepSession, ShopResult } from "./net/lockstep";
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

const DEFAULT_SHOP_SECONDS = 60; // flat between-round shop window (60s or you get nothing)
const SHOP_GRACE_SECONDS = 2; // host waits this long past the window for late carts in flight
const DEFAULT_MAX_TURNS = 40; // host force-ends a round that runs this long (stalemate/AFK backstop)
const DEFAULT_TURN_SECONDS = 30; // host forfeits the active player's turn after this long
const DROP_GRACE_SECONDS = 6; // a peer gone this long (past reconnect) ends the match

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
  // ── between-round shop (flat timed window; see _coordinateShop) ──
  private shopRound = -1; // round_index the current shop was initialized for
  private shopElapsed = 0; // real-time spent in the shop window
  private shopStack: Screen[] = []; // local shop UI (ShopScreen + Sell/Inventory sub-screens)
  private shopDone = false; // local player finished shopping (clicked Done or timed out)
  private shopSubmitted = false; // local cart broadcast/recorded this shop
  private shopfinApplied = false; // authoritative outcome applied -> advanced to next round
  private shopResults = new Map<string, ShopResult>(); // host: deviceId -> submitted cart
  private preShop = new Map<string, ShopResult>(); // host: deviceId -> pre-shop state ("nothing")
  private pendingShopFinal: Record<string, ShopResult> | null = null; // guest: outcome to apply
  private banner = "";
  private readonly shopSeconds: number;
  private readonly maxTurns: number;
  private readonly turnSeconds: number;
  private turnsThisRound = 0;
  private lastRound = -1;
  private lastShooter: unknown = null;
  private turnElapsed = 0; // real-time on the current AIM turn (host turn-timeout)
  private turnForfeited = false;
  private startCount = 0; // roster size at match start (disconnect detection)
  private droppedFor = 0; // real-time a player has been disconnected
  private aborted = ""; // non-empty => match ended (e.g., a player left)
  private overQuote: readonly [string, string] | null = null; // game-over war quote, picked once

  constructor(app: MpApp, session: LockstepSession, adapter: GameEngineAdapter, role: Role) {
    super();
    this.app = app;
    this.session = session;
    this.adapter = adapter;
    this.role = role;
    this.isHost = role === "host";
    const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
    this.shopSeconds = Number(params.get("shopSeconds")) || DEFAULT_SHOP_SECONDS;
    this.maxTurns = Number(params.get("maxTurns")) || DEFAULT_MAX_TURNS;
    this.turnSeconds = Number(params.get("turnSeconds")) || DEFAULT_TURN_SECONDS;
    this.session.onControl = (kind) => {
      const gs = this.adapter.state();
      if (!gs) return;
      // round-end and force-end are deterministic on every client (no message); the
      // shop barrier rides its own host-authoritative shopfin. Only the forfeit is a
      // real-time host decision broadcast as a control message.
      if (kind === "forfeit") {
        if (!this.isHost && gs.phase === AIM) {
          gs.retreat(); // forfeit the timed-out tank's round; advances the turn at the AIM barrier
          this.turnForfeited = true;
        }
      }
    };
    // Host aggregates each peer's finalized cart; guests stash the authoritative
    // outcome and apply it in the update loop (not in this network callback).
    this.session.onShopResult = (deviceId, inv, cash) => {
      if (this.isHost) this.shopResults.set(deviceId, { inv, cash });
    };
    this.session.onShopFinal = (results) => {
      if (!this.isHost) this.pendingShopFinal = results;
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
    // While the local shop is open it takes all input (until ~Done or the window ends);
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
    const gs = this.adapter.state();
    if (!gs) return null;
    this.gsRef = gs;
    this._wireFire(gs);

    if (this._isMyTurn() && gs.phase === AIM) {
      ingame.update_game_input(gs as never, dt, this.app.keys());
    }

    // Step the simulation on the fixed dt (animates flight / AI turns deterministically).
    (gs as unknown as { update(dt: number): void }).update(FIXED_DT);

    this._trackTurns(gs);
    // Apply the next buffered remote turn only now that we are at our OWN AIM barrier
    // (previous flight resolved) -- the lockstep frame-sync that keeps clients converged.
    if (gs.phase === AIM && !this._isMyTurn()) this.session.tryPump();
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
    const connected = players.filter((p) => p.connected || p.deviceId === DEVICE_ID).length;
    if (this.startCount === 0 && connected >= 2) this.startCount = connected;
    // End the match only when you are the last one connected; a 3+ player match keeps
    // going (1v1) after a single drop instead of ending for everyone.
    if (this.startCount >= 2 && connected < 2) {
      this.droppedFor += dt;
      if (this.droppedFor > DROP_GRACE_SECONDS) this.aborted = "You are the last player connected.";
    } else {
      this.droppedFor = 0;
    }
    // Every client advances the turn clock so the ACTIVE player sees their own
    // countdown; only the host acts on it (authoritative forfeit broadcast).
    if (gs.phase === AIM && !this.turnForfeited) {
      this.turnElapsed += dt;
      if (this.isHost && this.turnElapsed > this.turnSeconds) {
        this.turnForfeited = true;
        this.session.sendControl("forfeit");
        gs.retreat(); // forfeit the AFK player's round; advances the turn (synced at AIM)
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

  /** Between-round shop: a flat timed window (default 60s). Each human shops their own
   *  tank locally; at the barrier (all done, or the window + grace elapses) the HOST
   *  broadcasts one authoritative post-shop snapshot of every human tank and every
   *  client applies it before begin_next_round, so message ordering can't desync the
   *  inventories. A player who is idle past the window gets the pre-shop state (nothing). */
  private _coordinateShop(gs: GameState, dt: number): void {
    if (this.shopRound !== gs.round_index) {
      // First frame of this shop: reset, and (host) snapshot pre-shop state = "nothing".
      this.shopRound = gs.round_index;
      this.shopElapsed = 0;
      this.shopDone = false;
      this.shopSubmitted = false;
      this.shopfinApplied = false;
      this.shopStack = [];
      this.shopResults.clear();
      this.preShop.clear();
      this.pendingShopFinal = null;
      if (this.isHost) {
        for (const d of this.adapter.humanDeviceIds()) {
          const s = this.adapter.shopSnapshot(d);
          if (s) this.preShop.set(d, s);
        }
      }
    }
    this.banner = "";
    if (this.shopfinApplied) return; // already advanced to the next round on this client

    // Guest: apply the host's authoritative outcome the moment it has arrived.
    if (!this.isHost && this.pendingShopFinal) {
      this._applyShopFinal(this.pendingShopFinal);
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
    // Local auto-finalize when the window elapses (idle => nothing); a non-human local
    // has nothing to submit, so it finalizes immediately so it never blocks the barrier.
    if (!this.shopSubmitted && (this.shopElapsed >= this.shopSeconds || !iAmHuman)) {
      this._submitLocalCart(iAmHuman);
    }

    // Host barrier: fire when every human submitted, or the window + grace elapsed.
    if (this.isHost) {
      const humans = this.adapter.humanDeviceIds();
      const allIn = humans.length > 0 && humans.every((d) => this.shopResults.has(d));
      if (allIn || this.shopElapsed >= this.shopSeconds + SHOP_GRACE_SECONDS) {
        const results: Record<string, ShopResult> = {};
        for (const d of humans) {
          const r = this.shopResults.get(d) ?? this.preShop.get(d);
          if (r) results[d] = r;
        }
        this.session.sendShopFinal(results);
        this._applyShopFinal(results);
      }
    }
  }

  /** Finalize the local player's purchases: snapshot inventory+cash, submit (guest
   *  broadcasts; host records its own), and close the shop UI. Idempotent per shop. */
  private _submitLocalCart(iAmHuman: boolean): void {
    if (this.shopSubmitted) return;
    this.shopSubmitted = true;
    this.shopDone = true;
    this.shopStack = [];
    if (!iAmHuman) return;
    const snap = this.adapter.shopSnapshot(DEVICE_ID);
    if (!snap) return;
    if (this.isHost) this.shopResults.set(DEVICE_ID, snap);
    else this.session.sendShop(snap.inv, snap.cash);
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
      const left = Math.max(0, Math.ceil(this.shopSeconds - this.shopElapsed));
      if (this.shopStack.length > 0) {
        // Local shop is open: draw it (its screens are opaque) + a window countdown.
        for (const s of this.shopStack) s.draw(surf);
        center(fs.render(`shop closes in ${left}s  -  ~Done to finish`, true, [235, 235, 235]), this.app.h - 22);
        return;
      }
      // Shopping done (or no shop for me): standings + countdown while others finish.
      const remain = Math.max(0, ((gs.cfg as { MAXROUNDS?: number }).MAXROUNDS ?? 0) - gs.round_index);
      ui.draw_rankings(surf, this.app.renderer as never, gs as never, "Standings", remain);
      const msg = left > 0 ? `next round in ${left}s` : "starting next round...";
      center(fs.render(msg, true, [235, 235, 235]), this.app.h - 40);
      this._drawConnSummary(surf, fs);
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
  }

  /** bottom-right: live connection summary (the "connection info during the match"). */
  private _drawConnSummary(surf: pygame.Surface, fs: pygame.Font): void {
    const players = this.session.match.players();
    const conn = players.filter((p) => p.connected || p.deviceId === DEVICE_ID).length;
    const cr = fs.render(`players ${conn}/${players.length}`, true, conn >= players.length ? [140, 230, 160] : [255, 180, 120]);
    surf.blit(cr, [this.app.w - cr.get_width() - 12, this.app.h - 24]);
  }
}
