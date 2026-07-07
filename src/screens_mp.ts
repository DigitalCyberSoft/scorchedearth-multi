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
import { Match, listPublicMatches, type MatchInfo, type RoomPlayer, type Role } from "./net/match";
import { LockstepSession, type MatchStart, type PlayerSlot } from "./net/lockstep";
import { createEngineAdapter, type GameEngineAdapter } from "./net/engine_adapter";
import { MpGameScreen, type MpApp } from "./screens_mp_game";
import { testHooks } from "./net/netconfig";

const AI_HUMAN = 0; // constants.AI_HUMAN

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
  private unsubList: (() => void) | null = null;
  private started = false;
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
    this.panel = this._build();
  }

  /** Once the engine state exists (host after Start; guest after the "start"
   *  message), hand off to the in-game MP screen. */
  override update(_dt: number): ScreenAction {
    if (!this.transitioned && this.session && this.adapter.state()) {
      this.transitioned = true;
      this.app.push(new MpGameScreen(this.app, this.session, this.adapter, this.role));
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
      // Start is gated until >=2 players are present AND every one of them is connected.
      const ps = this.match.players();
      if (ps.length >= 2 && ps.every((p) => p.connected || p.deviceId === DEVICE_ID)) {
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
  }

  override handle(e: ScreenEvent): ScreenAction {
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
    else if (a.startsWith("mp_joinpub_")) void this._joinPublic(Number(a.slice("mp_joinpub_".length)));
    return null; // handled internally; do not bubble
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  private async _create(isPublic: boolean): Promise<void> {
    this._cleanup();
    this.status = isPublic ? "Creating public match..." : "Creating private match...";
    this.match = isPublic
      ? await Match.createPublic("Scorch Game", this.cfg.MAXPLAYERS, this.myName, this.myTankIcon)
      : await Match.createPrivate("Scorch Game", this.cfg.MAXPLAYERS, this.myName, this.myTankIcon);
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

  private async _list(): Promise<void> {
    this.unsubList?.();
    this.status = "Public games (live):";
    this.unsubList = await listPublicMatches((ms) => {
      this.publicMatches = ms;
      this._rebuild();
    });
  }

  private _start(): void {
    if (!this.match || this.match.role !== "host" || !this.session || this.started) return;
    const players = this.match.players();
    if (players.length < 2 || !players.every((p) => p.connected || p.deviceId === DEVICE_ID)) {
      this.status = "Waiting for all players to connect before starting.";
      this._rebuild();
      return;
    }
    const order: PlayerSlot[] = players.map((p) => ({
      deviceId: p.deviceId,
      name: p.name,
      tankIcon: p.tankIcon, // each player's chosen tank (carried via presence)
      aiClass: AI_HUMAN,
    }));
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const start: MatchStart = {
      seed,
      w: this.w,
      h: this.h,
      cfg: { ...(this.cfg as unknown as Record<string, unknown>) },
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
    this.session.onDesync = (n, peer) => {
      this.lines.push(`DESYNC turn ${n} from ${peer.slice(0, 6)}`);
      if (testHooks()) {
        const g = globalThis as Record<string, unknown>;
        g.__mpDesyncs = ((g.__mpDesyncs as number) ?? 0) + 1;
      }
    };
  }

  private _cleanup(): void {
    this.unsubList?.();
    this.unsubList = null;
    this.match?.leave();
    this.match = null;
    this.session = null;
    this.roster = [];
    this.started = false;
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
      if (this.match.role === "host" && !this.started) {
        const ps = this.match.players();
        if (ps.length < 2) line("Waiting for another player to join...", C_WAIT);
        else if (!ps.every((p) => p.connected || p.deviceId === DEVICE_ID)) line("Waiting for players to connect...", C_WAIT);
        else line("Ready -- press Start Match.", C_OK);
      }
    }

    if (this.publicMatches.length && !this.match) {
      y += 8;
      line("Open public games:", W.C_TEXT, true);
      this.publicMatches.forEach((m, i) => line(`  ${i + 1}. ${m.name} - ${m.players}/${m.maxPlayers}`));
    }

    draw_cursor(surf);
  }
}

/** Break a long string into lines of <= n chars (for the invite-code display). */
function wrap(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}
