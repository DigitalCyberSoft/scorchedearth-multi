// ───────────────────────────────────────────────────────────────────────────
// MULTIPLAYER LOBBY SCREEN.
//
// Drives the net layer end to end: create a private match (shareable invite code)
// or a public match (announced on the lobby channel), browse + join public matches,
// watch the roster connect over WebRTC, and (host) Start -> seed every client's
// engine via lockstep, then hand off to MpGameScreen for the in-game turn loop.
// Start is gated until at least two players are present and all are connected.
// ───────────────────────────────────────────────────────────────────────────
import * as pygame from "./pygame";
import * as W from "./widgets";
import { Panel, Button, draw_cursor } from "./widgets";
import { Screen } from "./screen";
import type { ScreenAction, ScreenEvent } from "./screen";
import type { Config } from "./config";
import { DEVICE_ID } from "./net/identity";
import { connectedRelays } from "./net/nostr";
import { Match, adoptPublicLobby, releasePublicLobby, type MatchInfo, type RoomPlayer, type Role } from "./net/match";
import { LockstepSession, type MatchStart, type PlayerSlot } from "./net/lockstep";
import { createEngineAdapter, type GameEngineAdapter } from "./net/engine_adapter";
import { MpGameScreen, type MpApp } from "./screens_mp_game";
import { ChatOverlay } from "./mp_chat";
import { testHooks } from "./net/netconfig";

const AI_HUMAN = 0; // constants.AI_HUMAN
const AI_UNKNOWN = 8; // constants.AI_UNKNOWN -- "random": the engine re-rolls a real class at reveal
const MAX_MP_TANKS = 10; // engine max tanks per round (config.py MAXPLAYERS range 2-10); NOT cfg.MAXPLAYERS, which is the SP player-count setting (default 2)

export class MultiplayerScreen extends Screen {
  override opaque = true;
  private readonly app: MpApp;
  cfg: Config;
  w: number;
  h: number;
  panel: Panel;

  private role: Role = "host";
  private transitioned = false;
  private myName: string;
  private myTankIcon: number;
  private status = "Peer-to-peer over Nostr relays. Create or join a match.";
  private lines: string[] = [];
  private match: Match | null = null;
  private session: LockstepSession | null = null;
  private readonly adapter: GameEngineAdapter = createEngineAdapter();
  private roster: RoomPlayer[] = [];
  private publicMatches: MatchInfo[] = [];
  private started = false;
  private aiCount = 0; // host-staged computer opponents (default class Unknown)
  private chat: ChatOverlay | null = null; // room chat (created with the match; carried into the game)
  private _rosterSig = ""; // last roster/connection signature (rebuild only on change)

  constructor(
    app: MpApp,
    cfg: Config,
    w: number,
    h: number,
    myName = "Player-" + DEVICE_ID.slice(0, 4),
    tankIcon = 0,
  ) {
    super();
    this.app = app;
    this.cfg = cfg;
    this.w = w;
    this.h = h;
    this.myName = myName;
    this.myTankIcon = tankIcon;
    // Adopt the discovery stream the Online Play click already started (relays
    // connected + public-match subscription live since the setup screen): the
    // list opens pre-populated and stays live without a manual refresh.
    this.publicMatches = adoptPublicLobby((ms) => {
      this.publicMatches = ms;
      this._rebuild();
    });
    this.status =
      this.publicMatches.length > 0
        ? "Public games (live):"
        : "Searching for public games... Create or join a match.";
    this.panel = this._build();
    this._emitLobbyHook();
  }

  /** Once the engine state exists (host after Start; guest after the "start"
   *  message), hand off to the in-game MP screen. */
  override update(dt: number): ScreenAction {
    this.chat?.tick(dt);
    if (!this.transitioned && this.session && this.chat && this.adapter.state()) {
      this.transitioned = true;
      // Hand the SAME chat overlay to the game screen: the lobby conversation
      // stays on screen across the match start.
      this.app.push(new MpGameScreen(this.app, this.session, this.adapter, this.role, this.chat));
    }
    return null;
  }

  private _build(): Panel {
    const p = new Panel(40, 40, 360, this.h - 110, "Online Play", true);
    const x = p.rect.x + 18;
    let y = p.rect.y + 36;
    const dy = 30;
    const add = (label: string, action: string) => {
      p.add(new Button(x, y, label, action, 320));
      y += dy;
    };
    add("Create ~Private Match", "mp_private");
    add("Create P~ublic Match", "mp_public");
    add("~Join by Code", "mp_join");
    add("Refresh Public ~Games", "mp_list");
    y += 10;
    if (this.match && this.match.role === "host" && !this.started) {
      if (!this.match.isPublic) add("~Copy Invite", "mp_copy");
      // Computer opponents (host-staged; carried to every client in the start order).
      const ps = this.match.players();
      if (ps.length + this.aiCount < MAX_MP_TANKS) add("A~dd Computer", "mp_add_ai");
      if (this.aiCount > 0) add(`~Remove Computer (${this.aiCount})`, "mp_del_ai");
      // Start is gated until >=2 tanks are staged (humans + computers) AND every
      // human present is connected. Host + computers alone is a valid match.
      if (ps.length + this.aiCount >= 2 && ps.every((p) => p.connected || p.deviceId === DEVICE_ID)) {
        add("~Start Match", "mp_start");
      }
    }
    // Join buttons for discovered public matches.
    this.publicMatches.slice(0, 6).forEach((m, i) => add(`Join: ${m.name} (${m.players}/${m.maxPlayers})`, "mp_joinpub_" + i));
    y += 10;
    add("~Back", "back");
    return p;
  }

  private _rebuild(): void {
    this.panel = this._build();
    this._emitLobbyHook();
  }

  /** test telemetry (harness only, ?test=1): the lobby list as rendered. */
  private _emitLobbyHook(): void {
    if (testHooks())
      (globalThis as Record<string, unknown>).__mpLobby = {
        matches: this.publicMatches.length,
        names: this.publicMatches.map((m) => m.name),
        status: this.status,
        relays: connectedRelays().length,
      };
  }

  override handle(e: ScreenEvent): ScreenAction {
    // Room chat, same interface as in-game: modal compose box (letters below are
    // panel accelerators, so the box must capture every key), backquote to open.
    if (this.chat) {
      if (this.chat.open && e.type === pygame.KEYDOWN) {
        this.chat.handleKey(e);
        return null;
      }
      if (e.type === pygame.KEYDOWN && e.key === pygame.K_BACKQUOTE) {
        this.chat.open = true;
        return null;
      }
    }
    const a = this.panel.handle(e);
    if (a === null) return null;
    if (a === "back") {
      this._cleanup();
      return "back";
    }
    if (a === "mp_private") void this._create(false);
    else if (a === "mp_public") void this._create(true);
    else if (a === "mp_join") void this._joinByCode();
    else if (a === "mp_list") void this._list();
    else if (a === "mp_start") this._start();
    else if (a === "mp_copy") this._copyInvite();
    else if (a === "mp_add_ai") {
      this.aiCount++;
      this._rebuild();
    } else if (a === "mp_del_ai") {
      this.aiCount = Math.max(0, this.aiCount - 1);
      this._rebuild();
    }
    else if (a.startsWith("mp_joinpub_")) void this._joinPublic(Number(a.slice("mp_joinpub_".length)));
    return null; // handled internally; do not bubble
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  private async _create(isPublic: boolean): Promise<void> {
    this._cleanup();
    this.status = isPublic ? "Creating public match..." : "Creating private match...";
    // Room capacity is the ENGINE limit (10 tanks), not the SP MAXPLAYERS setting
    // (default 2): people can keep joining until the host starts the match.
    this.match = isPublic
      ? await Match.createPublic("Scorch Game", MAX_MP_TANKS, this.myName, this.myTankIcon)
      : await Match.createPrivate("Scorch Game", MAX_MP_TANKS, this.myName, this.myTankIcon);
    this._wireMatch("host");
    if (testHooks()) (globalThis as Record<string, unknown>).__mpInvite = this.match.inviteCode();
    if (isPublic) {
      this.status = "Public match listed. Waiting for players to join...";
      this.lines = [];
    } else {
      this.status = "Private match created. Share this invite code:";
      this.lines = wrap(this.match.inviteCode(), 46);
    }
    this._rebuild();
  }

  private async _joinByCode(): Promise<void> {
    const code = typeof prompt === "function" ? prompt("Paste invite code:") : null;
    if (!code) return;
    const info = Match.parseInvite(code);
    if (!info) {
      this.status = "Invalid invite code.";
      return;
    }
    await this._join(info);
  }

  private async _joinPublic(i: number): Promise<void> {
    const info = this.publicMatches[i];
    if (info) await this._join(info);
  }

  private async _join(info: MatchInfo): Promise<void> {
    this._cleanup();
    this.status = `Joining "${info.name}"...`;
    this.match = await Match.join(info, this.myName, this.myTankIcon);
    this._wireMatch("guest");
    this.lines = [];
    this._rebuild();
  }

  private _list(): void {
    // Manual refresh: restart the live discovery with a fresh seen-set (drops
    // any entry whose announcer went away without expiring).
    releasePublicLobby();
    this.publicMatches = adoptPublicLobby((ms) => {
      this.publicMatches = ms;
      this._rebuild();
    });
    this.status = "Public games (live):";
    this._rebuild();
  }

  private _start(): void {
    if (!this.match || this.match.role !== "host" || !this.session || this.started) return;
    const players = this.match.players();
    // >=2 tanks total (humans + staged computers) and every human connected --
    // matches the Start button's visibility gate (host-vs-computers is allowed).
    if (players.length + this.aiCount < 2 || !players.every((p) => p.connected || p.deviceId === DEVICE_ID)) {
      this.status = "Waiting for all players to connect before starting.";
      this._rebuild();
      return;
    }
    const order: PlayerSlot[] = players.slice(0, MAX_MP_TANKS).map((p) => ({
      deviceId: p.deviceId,
      name: p.name,
      tankIcon: p.tankIcon, // each player's chosen tank (carried via presence)
      aiClass: AI_HUMAN,
    }));
    // Host-staged computer opponents. Class Unknown = the engine re-rolls a random
    // real class at first reveal (deterministic: seeded rng, same on every client).
    // Humans outrank computers: late joiners can shrink the AI allotment, and the
    // total is clamped to the engine's 10-tank round limit.
    const humanCount = order.length;
    const aiRoom = Math.max(0, Math.min(this.aiCount, MAX_MP_TANKS - humanCount));
    for (let i = 0; i < aiRoom; i++) {
      order.push({
        deviceId: `ai-${i + 1}`, // never a real DEVICE_ID: no client claims its turns
        name: `Computer ${i + 1}`,
        tankIcon: (humanCount + i) % 7,
        aiClass: AI_UNKNOWN,
      });
    }
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    // The broadcast cfg is the host's PERSISTED single-player config (localStorage
    // scorch.cfg), so SP settings that change the round-flow contract must be
    // sanitized out. TEAM_MODE: the MP roster gives every player the same team_id
    // default, so any team mode makes _win_check see ONE alive team and end the
    // round at the first turn (reproduced: straight to the shop with everyone
    // alive and zero shots fired). PLAY_MODE: the MP loop (fire wrapper, AIM
    // barrier, turn pump) is built for SEQUENTIAL only; SYNCHRONOUS/SIMULTANEOUS
    // route the engine into SYNC_AIM/SIM_LIVE, which MP does not drive.
    // TALKING_TANKS: default the COMPUTER taunts ON for online matches.  The
    // engine default is OFF (oracle-locked), and most hosts have OFF persisted,
    // so an MP room would never see the taunt system at all; map OFF -> the
    // computers-only tier and keep an explicit ALL (host chose it in SP config).
    const talking = String(
      (this.cfg as unknown as Record<string, unknown>).TALKING_TANKS ?? "OFF",
    ).toUpperCase();
    const start: MatchStart = {
      seed,
      w: this.w,
      h: this.h,
      cfg: {
        ...(this.cfg as unknown as Record<string, unknown>),
        TEAM_MODE: "NONE",
        PLAY_MODE: "SEQUENTIAL",
        TALKING_TANKS: talking === "ALL" ? "ALL" : "COMPUTERS",
      },
      order,
    };
    this.session.startMatch(start);
    this.started = true;
    this.status = `Match started (seed ${seed}).`;
    this._rebuild();
  }

  private _copyInvite(): void {
    if (!this.match) return;
    const code = this.match.inviteCode();
    const nav = (globalThis as { navigator?: { clipboard?: { writeText(s: string): Promise<void> } } }).navigator;
    if (nav?.clipboard?.writeText) {
      void nav.clipboard.writeText(code).then(
        () => { this.status = "Invite code copied to clipboard."; this._rebuild(); },
        () => { this.status = "Copy failed -- select the code text below to copy it."; this._rebuild(); },
      );
    } else {
      this.status = "Clipboard unavailable -- copy the code text shown below.";
      this._rebuild();
    }
  }

  private _wireMatch(role: "host" | "guest"): void {
    if (!this.match) return;
    this.role = role;
    // Room chat over the mesh data channels -- live from the moment peers connect,
    // so people can talk while waiting for the host to start.
    this.chat = new ChatOverlay(
      (t) => this.session?.sendChat(t),
      () => this.myName,
    );
    this.match.handlers.onRoster = (ps) => {
      this.roster = ps;
      // Rebuild only when the roster or a connection state changes, so the host's Start
      // button appears the moment all players connect (without per-heartbeat flicker).
      const sig = ps.map((p) => `${p.deviceId}:${p.connected}`).join("|");
      if (sig !== this._rosterSig) {
        this._rosterSig = sig;
        this._rebuild();
      }
      if (testHooks()) {
        const g = globalThis as Record<string, unknown>;
        g.__mpConnected = ps.filter((p) => p.connected || p.deviceId === DEVICE_ID).length;
        g.__mpRoster = ps.map((p) => ({ id: p.deviceId.slice(0, 6), c: p.connected }));
      }
    };
    if (testHooks()) {
      this.match.handlers.onConnection = (peerId, state) => {
        const g = globalThis as Record<string, unknown>;
        const m = (g.__mpStates as Record<string, string>) ?? {};
        m[peerId.slice(0, 6)] = state;
        g.__mpStates = m;
      };
    }
    this.match.handlers.onRoster?.(this.match.players()); // seed roster (self)
    this.session = new LockstepSession(this.match, this.adapter, role);
    this.session.onChat = (deviceId, text) => {
      const name = this.match?.players().find((p) => p.deviceId === deviceId)?.name ?? deviceId.slice(0, 6);
      this.chat?.push(name, text);
      if (testHooks()) {
        (globalThis as Record<string, unknown>).__mpLobbyChat = { count: this.chat?.count() ?? 0, last: this.chat?.last() ?? null };
      }
    };
    this.session.onDesync = (n, peer) => {
      this.lines.push(`DESYNC turn ${n} from ${peer.slice(0, 6)}`);
      if (testHooks()) {
        const g = globalThis as Record<string, unknown>;
        g.__mpDesyncs = ((g.__mpDesyncs as number) ?? 0) + 1;
      }
    };
  }

  private _cleanup(): void {
    releasePublicLobby();
    this.match?.leave();
    this.match = null;
    this.session = null;
    this.roster = [];
    this.started = false;
    this.aiCount = 0;
    this.chat = null;
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  override draw(surf: pygame.Surface): void {
    surf.fill(W.C_BG);
    this.panel.draw(surf, false);

    // Right-hand info column: a second grey Panel matching the left panel's idiom
    // (the original frames all information in grey dialogs, not free desktop text).
    const rp = new Panel(420, 40, this.w - 460, this.h - 110, "Lobby", true);
    rp.draw(surf, false);
    const x = rp.rect.x + 16;
    let y = rp.rect.y + 40;
    const maxY = rp.rect.y + rp.rect.height - 18;
    const f = W.font(15, false);
    const fb = W.font(16, true);
    const C_OK: [number, number, number] = [0, 110, 0];
    const C_WAIT: [number, number, number] = [150, 90, 0];
    const line = (s: string, color: [number, number, number] = W.C_TEXT, bold = false): void => {
      if (y > maxY) return; // clamp: never overflow the panel bottom
      surf.blit((bold ? fb : f).render(s, true, color), [x, y]);
      y += (bold ? fb : f).get_height() + 4;
    };

    line(`You: ${this.myName}   device ${DEVICE_ID.slice(0, 8)}`);
    line(`Relays connected: ${connectedRelays().length}`);
    y += 4;
    line(this.status, W.C_SEL, true);
    for (const l of this.lines) line(l);

    if (this.match) {
      y += 8;
      line(`Room "${this.match.name}"  (${this.match.role})`, W.C_TEXT, true);
      for (const p of this.roster) {
        const tag = p.deviceId === DEVICE_ID ? " (you)" : p.connected ? " [connected]" : " [connecting]";
        line(`  ${p.name}${tag}`, p.connected || p.deviceId === DEVICE_ID ? C_OK : C_WAIT);
      }
      for (let i = 0; i < this.aiCount; i++) line(`  Computer ${i + 1} [AI: Unknown]`, C_OK);
      line("` to chat with the room", W.C_TEXT);
      if (this.match.role === "host" && !this.started) {
        const ps = this.match.players();
        if (ps.length + this.aiCount < 2) line("Add a computer or wait for a player to join...", C_WAIT);
        else if (!ps.every((p) => p.connected || p.deviceId === DEVICE_ID)) line("Waiting for players to connect...", C_WAIT);
        else line("Ready -- press Start Match. Joins stay open until you start.", C_OK);
      }
    }

    if (this.publicMatches.length && !this.match) {
      y += 8;
      line("Open public games:", W.C_TEXT, true);
      this.publicMatches.forEach((m, i) => line(`  ${i + 1}. ${m.name} - ${m.players}/${m.maxPlayers}`));
    }

    this.chat?.draw(surf, this.w, this.h); // room chat rides over the lobby panels
    draw_cursor(surf);
  }
}

/** Break a long string into lines of <= n chars (for the invite-code display). */
function wrap(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}
