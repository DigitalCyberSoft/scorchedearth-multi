// ───────────────────────────────────────────────────────────────────────────
// MATCH — a room: presence-driven WebRTC mesh + private invites / public listing.
//
//   private match : a fresh room key shared out-of-band as an invite code (link/QR).
//   public  match : same, plus a refreshed announcement on the PUBLIC_LOBBY_KEY
//                   channel so anyone can discover + join it.
//
// Match owns transport + roster only. The game protocol (seed, turns, hashing)
// lives in lockstep.ts and rides Match.broadcast / Match.onMessage.
// ───────────────────────────────────────────────────────────────────────────
import {
  activeRelays,
  PUBLIC_LOBBY_KEY,
  LOBBY_KIND,
  PRESENCE_INTERVAL_MS,
  ANNOUNCE_INTERVAL_MS,
  ANNOUNCE_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
  testHooks,
} from "./netconfig";
import { DEVICE_ID, uid } from "./identity";
import { ensureRelays, generateRoomKey, publishReplaceable, subscribeReplaceable } from "./nostr";
import { subscribeSignaling, sendPresence } from "./signaling";
import { PeerManager, type ConnState } from "./peer";

export type Role = "host" | "guest";

export interface MatchInfo {
  v: number;
  matchId: string;
  name: string;
  hostId: string;
  roomKey: string;
  maxPlayers: number;
  players: number;
  status: "open" | "starting" | "playing";
  ts: number;
}

export interface RoomPlayer {
  deviceId: string;
  name: string;
  tankIcon: number;
  connected: boolean;
  lastSeen: number;
}

export interface MatchHandlers {
  onRoster?: (players: RoomPlayer[]) => void;
  onMessage?: (peerId: string, msg: unknown) => void;
  onConnection?: (peerId: string, state: ConnState) => void;
}

interface MatchInit {
  role: Role;
  roomKey: string;
  matchId: string;
  name: string;
  hostId: string;
  maxPlayers: number;
  isPublic: boolean;
  myName: string;
  myTankIcon: number;
  relays: readonly string[];
}

export class Match {
  readonly role: Role;
  readonly roomKey: string;
  readonly matchId: string;
  readonly name: string;
  readonly hostId: string;
  readonly maxPlayers: number;
  readonly isPublic: boolean;
  readonly relays: readonly string[];
  private readonly myName: string;
  private readonly myTankIcon: number;
  private readonly peers = new PeerManager();
  private readonly roster = new Map<string, RoomPlayer>();
  handlers: MatchHandlers = {};

  private _presenceTimer: ReturnType<typeof setInterval> | null = null;
  private _announceTimer: ReturnType<typeof setInterval> | null = null;
  private _pruneTimer: ReturnType<typeof setInterval> | null = null;
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _unsubSignaling: (() => void) | null = null;
  private _status: MatchInfo["status"] = "open";

  private constructor(init: MatchInit) {
    this.role = init.role;
    this.roomKey = init.roomKey;
    this.matchId = init.matchId;
    this.name = init.name;
    this.hostId = init.hostId;
    this.maxPlayers = init.maxPlayers;
    this.isPublic = init.isPublic;
    this.relays = init.relays;
    this.myName = init.myName;
    this.myTankIcon = init.myTankIcon;
    this.roster.set(DEVICE_ID, {
      deviceId: DEVICE_ID,
      name: this.myName,
      tankIcon: this.myTankIcon,
      connected: true,
      lastSeen: Date.now(),
    });
  }

  // ── Factories ──────────────────────────────────────────────────────────────

  static async createPrivate(name: string, maxPlayers: number, myName: string, myTankIcon: number, relays = activeRelays()): Promise<Match> {
    const m = new Match({
      role: "host",
      roomKey: await generateRoomKey(),
      matchId: uid(),
      name,
      hostId: DEVICE_ID,
      maxPlayers,
      isPublic: false,
      myName,
      myTankIcon,
      relays,
    });
    await m._open();
    return m;
  }

  static async createPublic(name: string, maxPlayers: number, myName: string, myTankIcon: number, relays = activeRelays()): Promise<Match> {
    const m = new Match({
      role: "host",
      roomKey: await generateRoomKey(),
      matchId: uid(),
      name,
      hostId: DEVICE_ID,
      maxPlayers,
      isPublic: true,
      myName,
      myTankIcon,
      relays,
    });
    await m._open();
    await m._announce();
    m._announceTimer = setInterval(() => void m._announce(), ANNOUNCE_INTERVAL_MS);
    return m;
  }

  static async join(info: MatchInfo, myName: string, myTankIcon: number, relays = activeRelays()): Promise<Match> {
    const m = new Match({
      role: "guest",
      roomKey: info.roomKey,
      matchId: info.matchId,
      name: info.name,
      hostId: info.hostId,
      maxPlayers: info.maxPlayers,
      isPublic: false,
      myName,
      myTankIcon,
      relays,
    });
    await m._open();
    return m;
  }

  // ── Invite codes (private match) ─────────────────────────────────────────────

  inviteCode(): string {
    const info: MatchInfo = {
      v: PROTOCOL_VERSION,
      matchId: this.matchId,
      name: this.name,
      hostId: this.hostId,
      roomKey: this.roomKey,
      maxPlayers: this.maxPlayers,
      players: this.roster.size,
      status: this._status,
      ts: Date.now(),
    };
    return btoa(JSON.stringify(info)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  static parseInvite(code: string): MatchInfo | null {
    try {
      const json = atob(code.trim().replace(/-/g, "+").replace(/_/g, "/"));
      const info = JSON.parse(json) as MatchInfo;
      if (!info.roomKey || !info.matchId || !info.hostId) return null;
      return info;
    } catch {
      return null;
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  private async _open(): Promise<void> {
    this.peers.onMessage = (peerId, msg) => this.handlers.onMessage?.(peerId, msg);
    this.peers.onConnectionChange = (peerId, state) => {
      const p = this.roster.get(peerId);
      if (p) p.connected = this.peers.isConnected(peerId);
      this.handlers.onConnection?.(peerId, state);
      this._emitRoster();
    };

    this._unsubSignaling = await subscribeSignaling(
      this.roomKey,
      {
        onOffer: (from, sdp) => void this.peers.handleOffer(from, sdp, this.roomKey, this.relays),
        onAnswer: (from, sdp) => void this.peers.handleAnswer(from, sdp),
        onIce: (from, c) => void this.peers.addIceCandidate(from, c),
        onPresence: (from, name, tankIcon) => this._onPresence(from, name, tankIcon),
      },
      this.relays,
    );

    void sendPresence(this.roomKey, this.myName, this.myTankIcon, this.relays);
    this._presenceTimer = setInterval(
      () => void sendPresence(this.roomKey, this.myName, this.myTankIcon, this.relays),
      PRESENCE_INTERVAL_MS,
    );
    this._pruneTimer = setInterval(() => this._prune(), PRESENCE_INTERVAL_MS);
    // Datachannel liveness ping: keeps msSinceHeard() fresh for live peers so the game
    // can distinguish a wedged peer (silent) from one merely thinking on its turn.
    this._heartbeatTimer = setInterval(() => this.peers.pingAll(), HEARTBEAT_INTERVAL_MS);
    this._emitRoster();
  }

  private _onPresence(from: string, name: string, tankIcon: number): void {
    const existing = this.roster.get(from);
    if (existing) {
      existing.name = name;
      existing.tankIcon = tankIcon;
      existing.lastSeen = Date.now();
      existing.connected = this.peers.isConnected(from);
    } else {
      // The WebRTC connection can already be open before this peer's first presence
      // (the offer/answer can land before a heartbeat), so seed connected from the
      // live peer state rather than assuming false.
      this.roster.set(from, { deviceId: from, name, tankIcon, connected: this.peers.isConnected(from), lastSeen: Date.now() });
    }
    // Full mesh: every member tries to connect to every other. PeerManager.connect
    // only offers when our id is the smaller, so exactly one side initiates.
    this.peers.connect(from, this.roomKey, this.relays);
    this._emitRoster();
  }

  private _prune(): void {
    const cutoff = Date.now() - PRESENCE_INTERVAL_MS * 3;
    let changed = false;
    for (const [id, p] of this.roster) {
      if (id === DEVICE_ID) continue;
      if (p.lastSeen < cutoff && !this.peers.isConnected(id)) {
        this.roster.delete(id);
        changed = true;
      }
    }
    if (changed) this._emitRoster();
  }

  private async _announce(): Promise<void> {
    if (!this.isPublic) return;
    const info: MatchInfo = {
      v: PROTOCOL_VERSION,
      matchId: this.matchId,
      name: this.name,
      hostId: this.hostId,
      roomKey: this.roomKey,
      maxPlayers: this.maxPlayers,
      players: this.roster.size,
      status: this._status,
      ts: Date.now(),
    };
    await publishReplaceable(LOBBY_KIND, PUBLIC_LOBBY_KEY, this.matchId, info, this.relays);
  }

  private _emitRoster(): void {
    this.handlers.onRoster?.([...this.roster.values()].sort((a, b) => a.deviceId.localeCompare(b.deviceId)));
  }

  // ── Public API for the lockstep layer / UI ──────────────────────────────────

  players(): RoomPlayer[] {
    return [...this.roster.values()].sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  setStatus(status: MatchInfo["status"]): void {
    this._status = status;
    if (this.isPublic) void this._announce();
  }

  broadcast(payload: unknown): number {
    return this.peers.broadcast(payload);
  }

  send(peerId: string, payload: unknown): boolean {
    return this.peers.send(peerId, payload);
  }

  /** ms since the last datachannel frame from a peer (Infinity if not open). The
   *  app-level liveness signal the game reads to catch a wedged-but-"connected" peer. */
  msSinceHeard(peerId: string): number {
    return this.peers.msSinceHeard(peerId);
  }

  leave(): void {
    if (this._presenceTimer) clearInterval(this._presenceTimer);
    if (this._announceTimer) clearInterval(this._announceTimer);
    if (this._pruneTimer) clearInterval(this._pruneTimer);
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._unsubSignaling?.();
    this.peers.closeAll();
    if (this.isPublic) {
      this._status = "playing";
      // last announcement goes stale on its own (no refresh) -> drops from the list
    }
  }
}

// ── Public match discovery ─────────────────────────────────────────────────────

/** Live list of open public matches (fresher than ANNOUNCE_TTL). Returns an unsub. */
export async function listPublicMatches(onUpdate: (matches: MatchInfo[]) => void): Promise<() => void> {
  const seen = new Map<string, MatchInfo>();
  const emit = () => {
    const now = Date.now();
    // Evict stale entries so a flood of distinct matchIds can't grow `seen` without
    // bound (anyone holding the world-known PUBLIC_LOBBY_KEY can publish announcements).
    for (const [id, m] of seen) if (now - m.ts >= ANNOUNCE_TTL_MS) seen.delete(id);
    const live = [...seen.values()].filter((m) => m.status === "open");
    live.sort((a, b) => b.ts - a.ts);
    onUpdate(live);
  };
  const unsub = await subscribeReplaceable<MatchInfo>(LOBBY_KIND, PUBLIC_LOBBY_KEY, (rec) => {
    if (rec.data?.matchId) {
      seen.set(rec.data.matchId, rec.data);
      emit();
    }
  });
  const tick = setInterval(emit, ANNOUNCE_INTERVAL_MS); // re-emit so stale entries drop
  return () => {
    clearInterval(tick);
    unsub();
  };
}

// ── Eager lobby warmup (Online Play click -> discovery starts immediately) ────
//
// The lobby list used to start only at the manual "Refresh Public Games" click,
// AFTER the player had typed a name on the setup screen -- so the first thing a
// joiner saw was an empty list. warmPublicLobby() is called the moment the
// Online Play menu item is chosen: it opens the relay websockets and starts the
// public-match subscription while the player is still on the tank-setup screen.
// The lobby screen then ADOPTS the warm stream (matches seen so far + live
// updates); releasePublicLobby() stops it when the setup is cancelled or the
// lobby closes.

type WarmLobby = { unsub: () => void; matches: MatchInfo[] };
let _warm: WarmLobby | null = null;
let _warmHook: ((ms: MatchInfo[]) => void) | null = null;

/** Connect the relay pool and start public-match discovery NOW. Idempotent. */
export function warmPublicLobby(): void {
  if (_warm) return;
  const w: WarmLobby = { unsub: () => {}, matches: [] };
  _warm = w;
  ensureRelays(activeRelays()); // open the websockets before any publish/subscribe
  void listPublicMatches((ms) => {
    w.matches = ms;
    if (_warm === w) _warmHook?.(ms);
    // test telemetry (harness only, ?test=1): proves discovery ran while the
    // player was still on the setup screen, before the lobby existed.
    if (testHooks())
      (globalThis as Record<string, unknown>).__mpWarm = { matches: ms.length, names: ms.map((m) => m.name) };
  }).then((unsub) => {
    if (_warm === w) w.unsub = unsub;
    else unsub(); // released while the subscription was still opening
  });
}

/** Adopt the warm discovery: re-points the update stream at `onUpdate` and
 *  returns the matches already seen. Starts the warmup if it was never begun
 *  (a path that skipped the Online Play menu item). */
export function adoptPublicLobby(onUpdate: (ms: MatchInfo[]) => void): MatchInfo[] {
  warmPublicLobby();
  _warmHook = onUpdate;
  return _warm ? _warm.matches.slice() : [];
}

/** Stop the warm discovery and drop its hook (setup cancelled / lobby closed). */
export function releasePublicLobby(): void {
  _warmHook = null;
  _warm?.unsub();
  _warm = null;
}
