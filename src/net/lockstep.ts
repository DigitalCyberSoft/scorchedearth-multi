// ───────────────────────────────────────────────────────────────────────────
// LOCKSTEP — host-authoritative deterministic multiplayer over Match transport.
//
// The game is turn-based and the engine is deterministic (seeded MT19937, fixed
// PHYSICS_DT), so we do NOT stream world state. Instead:
//   - the host fixes the seed + config + turn order and broadcasts MATCH_START;
//   - the active player broadcasts only its TURN input (angle/power/weapon/moves);
//   - every client feeds that input through the same engine and converges;
//   - after each turn every client hashes its world and the host compares. The
//     host's hash is canonical; on mismatch it flags a desync (auto-heal via
//     snapshot is the next step; see EngineAdapter.snapshot).
//
// The engine is reached only through EngineAdapter, so this module has no direct
// game.ts dependency and is unit-testable with a fake adapter.
// ───────────────────────────────────────────────────────────────────────────
import { DEVICE_ID } from "./identity";
import type { Match, Role } from "./match";

export interface PlayerSlot {
  deviceId: string;
  name: string;
  tankIcon: number;
  aiClass: number;
}

export interface MatchStart {
  seed: number;
  w: number;
  h: number;
  cfg: Record<string, unknown>;
  order: PlayerSlot[];
}

export interface TurnInput {
  angle: number;
  power: number;
  weapon: number;
  moves: number[]; // pre-fire drive steps (engine maps these; [] for none)
}

/** A human tank's post-shop state (everything the shop changes). Replicated so every
 *  client converges on the same inventory; shields are inventory items that
 *  begin_next_round arms deterministically. */
export interface ShopResult {
  inv: number[];
  cash: number;
}

/** The lockstep layer's only window into the engine. */
export interface EngineAdapter {
  startMatch(start: MatchStart): void;
  /** Device id of the player whose turn it is, or null between turns. */
  activeDeviceId(): string | null;
  applyTurnInput(input: TurnInput): void;
  /** Order-independent digest of the simulation-relevant world state. */
  worldHash(): string;
  /** Authoritative state for resync, or null if snapshotting is unavailable. */
  snapshot(): unknown;
  restore(snap: unknown): void;
}

type Wire =
  | { t: "start"; start: MatchStart }
  | { t: "turn"; n: number; from: string; input: TurnInput }
  | { t: "hash"; n: number; from: string; hash: string }
  | { t: "snap"; n: number; snap: unknown }
  | { t: "ctrl"; kind: string; data?: unknown }
  | { t: "shop"; from: string; inv: number[]; cash: number }
  | { t: "shopfin"; results: Record<string, ShopResult> };

// Anti-abuse bounds on buffered remote input. A peer controls every byte it sends,
// so the buffer must not grow without limit and must not let one peer act for another.
const TURN_WINDOW = 8; // accept turns at most this many ahead of the applied one
const MAX_PENDING_TURNS = 32; // hard cap on buffered turn slots (OOM backstop)
const MAX_MOVES = 256; // cap pre-fire drive steps carried per turn (engine ignores them today)

export class LockstepSession {
  private turnNo = 0;
  private started = false; // a MATCH_START has been applied (reject duplicate/forged starts)
  // turn number -> (sender deviceId -> input). Per-sender so a forged turn from a
  // non-active peer can never overwrite the real active player's input; tryPump only
  // ever applies the bucket entry whose sender is the current shooter.
  private pending = new Map<number, Map<string, TurnInput>>();
  private myHashes = new Map<number, string>();
  private peerHashes = new Map<number, Map<string, string>>();
  onDesync: ((turn: number, peer: string) => void) | null = null;
  onTurnApplied: ((turn: number) => void) | null = null;
  /** Out-of-band match-control messages (round/shop transitions, timers), used by
   *  the in-game screen for host-driven coordination that is not a deterministic
   *  turn input. */
  onControl: ((kind: string, data: unknown) => void) | null = null;
  /** A peer finalized its own shop purchases (the host aggregates these). */
  onShopResult: ((deviceId: string, inv: number[], cash: number) => void) | null = null;
  /** Host-authoritative post-shop state for every human tank (guests apply it). */
  onShopFinal: ((results: Record<string, ShopResult>) => void) | null = null;

  constructor(
    readonly match: Match,
    private adapter: EngineAdapter,
    private role: Role,
  ) {
    const prev = match.handlers.onMessage;
    match.handlers.onMessage = (peerId, msg) => {
      prev?.(peerId, msg);
      this._onWire(peerId, msg);
    };
  }

  /** Host: seed the match and tell everyone to start. */
  startMatch(start: MatchStart): void {
    this.started = true;
    this.adapter.startMatch(start);
    this.match.setStatus("playing");
    this.match.broadcast({ t: "start", start } satisfies Wire);
  }

  /** Active player: lock in this turn's input and broadcast it. */
  commitTurn(input: TurnInput): void {
    const n = ++this.turnNo;
    this.match.broadcast({ t: "turn", n, from: DEVICE_ID, input } satisfies Wire);
    this._applyTurn(n, input);
  }

  /** Whose turn it is, per the local (converged) engine state. */
  activeDeviceId(): string | null {
    return this.adapter.activeDeviceId();
  }

  /** Broadcast an out-of-band control message (host-driven round/shop coordination). */
  sendControl(kind: string, data?: unknown): void {
    this.match.broadcast({ t: "ctrl", kind, data } satisfies Wire);
  }

  /** A player broadcasts its own finalized shop cart (self-only; the host aggregates). */
  sendShop(inv: number[], cash: number): void {
    this.match.broadcast({ t: "shop", from: DEVICE_ID, inv, cash } satisfies Wire);
  }

  /** Host broadcasts the authoritative post-shop state for every human tank. */
  sendShopFinal(results: Record<string, ShopResult>): void {
    this.match.broadcast({ t: "shopfin", results } satisfies Wire);
  }

  /** Apply the next buffered remote turn IFF the local engine has reached its AIM
   *  barrier (caller checks phase). Keeps every client applying turns in the same
   *  order at the same state even though they animate flight at different rates.
   *  Returns true if a turn was applied. */
  tryPump(): boolean {
    const n = this.turnNo + 1;
    const bucket = this.pending.get(n);
    if (!bucket) return false;
    const active = this.adapter.activeDeviceId();
    const input = active ? bucket.get(active) : undefined;
    if (input === undefined) return false; // the active player's input hasn't arrived yet
    this.pending.delete(n); // drops the whole bucket, including any forged non-active entries
    this.turnNo = n;
    this._applyTurn(n, input);
    return true;
  }

  private _onWire(peerId: string, raw: unknown): void {
    const msg = raw as Wire;
    if (!msg || typeof (msg as { t?: unknown }).t !== "string") return;
    switch (msg.t) {
      case "start":
        // Host-authoritative and once-only. peerId is the authenticated far end of the
        // data channel (peer.ts), so a guest forging "start" is rejected.
        if (this.role === "guest" && peerId === this.match.hostId && !this.started) {
          this.started = true;
          this.adapter.startMatch(msg.start);
        }
        break;
      case "turn":
        // Do NOT apply on arrival: a slower client may still be animating the
        // previous flight. Buffer and apply at the local AIM barrier (tryPump), so
        // every client applies turns in the same order at the same state.
        this._bufferTurn(peerId, msg);
        break;
      case "hash":
        // Only the channel's own peer may report its hash (no impersonation).
        if (this.role === "host" && msg.from === peerId) this._recordHash(msg.n, msg.from, msg.hash);
        break;
      case "snap":
        if (this.role === "guest" && peerId === this.match.hostId) this.adapter.restore(msg.snap);
        break;
      case "ctrl":
        // Out-of-band round/shop control is host-only (else any peer could forfeit
        // another player's turn or force the round to advance).
        if (peerId === this.match.hostId) this.onControl?.(msg.kind, msg.data);
        break;
      case "shop":
        // A player's own finalized cart: self-only (a peer can submit only its own
        // tank). Values are clamped on apply (engine_adapter), so just a light check.
        if (typeof msg.from === "string" && msg.from === peerId && Array.isArray(msg.inv)) {
          this.onShopResult?.(msg.from, msg.inv.slice(0, 64), Number(msg.cash) || 0);
        }
        break;
      case "shopfin":
        // Host-authoritative post-shop outcome for all human tanks.
        if (peerId === this.match.hostId && msg.results && typeof msg.results === "object") {
          this.onShopFinal?.(msg.results);
        }
        break;
    }
  }

  /** Buffer a remote turn under (turnNo, turnNo+WINDOW], keyed by sender. Rejects
   *  out-of-window / non-integer turn numbers (OOM via far-future n), a sender that
   *  doesn't match the channel (impersonation), and caps the buffer + the moves list. */
  private _bufferTurn(peerId: string, msg: { n: number; from: string; input: TurnInput }): void {
    const n = msg.n;
    if (!Number.isInteger(n) || n <= this.turnNo || n > this.turnNo + TURN_WINDOW) return;
    if (typeof msg.from !== "string" || msg.from !== peerId) return;
    if (!msg.input || typeof msg.input !== "object") return;
    if (this.pending.size >= MAX_PENDING_TURNS && !this.pending.has(n)) return;
    const raw = msg.input;
    const input: TurnInput = {
      angle: Number(raw.angle) || 0,
      power: Number(raw.power) || 0,
      weapon: Number(raw.weapon) || 0,
      moves: Array.isArray(raw.moves) ? raw.moves.slice(0, MAX_MOVES) : [],
    };
    let bucket = this.pending.get(n);
    if (!bucket) {
      bucket = new Map();
      this.pending.set(n, bucket);
    }
    bucket.set(msg.from, input);
  }

  private _applyTurn(n: number, input: TurnInput): void {
    this.adapter.applyTurnInput(input);
    const h = this.adapter.worldHash();
    this.myHashes.set(n, h);
    this.onTurnApplied?.(n);
    if (this.role === "host") this._recordHash(n, DEVICE_ID, h);
    else this.match.broadcast({ t: "hash", n, from: DEVICE_ID, hash: h } satisfies Wire);
  }

  /** Host: compare a peer's per-turn hash against our canonical one. */
  private _recordHash(n: number, from: string, hash: string): void {
    let m = this.peerHashes.get(n);
    if (!m) {
      m = new Map();
      this.peerHashes.set(n, m);
    }
    m.set(from, hash);
    const canon = this.myHashes.get(n);
    if (canon !== undefined && from !== DEVICE_ID && hash !== canon) {
      this.onDesync?.(n, from);
      const snap = this.adapter.snapshot();
      if (snap !== null) this.match.broadcast({ t: "snap", n, snap } satisfies Wire);
    }
  }
}
