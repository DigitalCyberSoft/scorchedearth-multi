// ───────────────────────────────────────────────────────────────────────────
// PEER MANAGER — N WebRTC data channels to room members (port of tasktank
// webrtc.js, trimmed to generic JSON messaging). The Nostr layer only carries the
// handshake; once a channel opens, game traffic flows peer-to-peer over it.
//
// Deterministic initiator: the peer with the lexically smaller device id creates
// the offer and owns reconnect, so two peers never both initiate.
// ───────────────────────────────────────────────────────────────────────────
import { rtcConfig, DC_LABEL, DC_CONFIG } from "./netconfig";
import { DEVICE_ID } from "./identity";
import { sendOffer, sendAnswer, sendIceCandidate } from "./signaling";

const MAX_BACKOFF_MS = 60_000;

interface Conn {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  encKey: string;
  relays: readonly string[];
  iceQueue: RTCIceCandidateInit[];
  backoff: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  remoteDescSet: boolean;
  lastHeard: number; // Date.now() of the last inbound datachannel frame (liveness)
}

// Reserved datachannel control frame: a liveness ping. Carries no `t`, so even if it
// reached the game layer lockstep would ignore it; it is intercepted here regardless.
const HEARTBEAT_FRAME = { __hb: 1 } as const;

export type ConnState = RTCPeerConnectionState;

export class PeerManager {
  private _conns = new Map<string, Conn>();
  onMessage: ((peerId: string, msg: unknown) => void) | null = null;
  onConnectionChange: ((peerId: string, state: ConnState) => void) | null = null;

  private _ensure(peerId: string, encKey: string, relays: readonly string[]): Conn {
    const existing = this._conns.get(peerId);
    if (existing) {
      const s = existing.pc.connectionState;
      if (s === "connected" || s === "connecting" || s === "new") return existing;
      this._cleanup(peerId, false);
    }
    const pc = new RTCPeerConnection(rtcConfig());
    const conn: Conn = { pc, dc: null, encKey, relays, iceQueue: [], backoff: 2000, reconnectTimer: null, remoteDescSet: false, lastHeard: Date.now() };
    this._conns.set(peerId, conn);

    pc.onicecandidate = (e) => {
      if (e.candidate) sendIceCandidate(encKey, peerId, e.candidate, relays).catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this.onConnectionChange?.(peerId, s);
      if (s === "connected") conn.backoff = 2000;
      else if (s === "failed" || s === "disconnected") this._scheduleReconnect(peerId);
    };
    pc.ondatachannel = (e) => this._setupDc(peerId, e.channel);
    return conn;
  }

  private _setupDc(peerId: string, dc: RTCDataChannel): void {
    const conn = this._conns.get(peerId);
    if (!conn) return;
    conn.dc = dc;
    dc.onopen = () => {
      conn.lastHeard = Date.now(); // fresh baseline so a just-opened peer is not "dead" pre-first-ping
      // The pc reaches "connected" BEFORE the data channel opens, so the
      // pc-state-change alone reports isConnected()=false (dc not yet open). Re-fire
      // the change on dc open so listeners (roster) see the now-complete connection.
      this.onConnectionChange?.(peerId, conn.pc.connectionState);
    };
    dc.onmessage = (e) => {
      conn.lastHeard = Date.now(); // ANY inbound frame (ping or game traffic) proves liveness
      try {
        const msg = JSON.parse(e.data as string);
        // Heartbeat pings are a transport-only liveness signal; never surface them to
        // the game layer.
        if (msg && (msg as { __hb?: unknown }).__hb !== undefined) return;
        this.onMessage?.(peerId, msg);
      } catch {
        /* non-JSON frame: ignore */
      }
    };
    dc.onclose = () => {
      if (conn.dc === dc) conn.dc = null;
    };
  }

  /** Begin connecting to a peer. Only the smaller device id actually offers; the
   *  larger waits for the offer (handled in handleOffer). */
  connect(peerId: string, encKey: string, relays: readonly string[]): void {
    const conn = this._ensure(peerId, encKey, relays);
    if (DEVICE_ID < peerId && (!conn.dc || conn.dc.readyState !== "open")) {
      this._createOffer(peerId).catch(() => {});
    }
  }

  private async _createOffer(peerId: string): Promise<void> {
    const conn = this._conns.get(peerId);
    if (!conn) return;
    this._setupDc(peerId, conn.pc.createDataChannel(DC_LABEL, DC_CONFIG));
    const offer = await conn.pc.createOffer();
    await conn.pc.setLocalDescription(offer);
    await sendOffer(conn.encKey, peerId, offer, conn.relays);
  }

  async handleOffer(peerId: string, offer: RTCSessionDescriptionInit, encKey: string, relays: readonly string[]): Promise<void> {
    const conn = this._ensure(peerId, encKey, relays);
    await conn.pc.setRemoteDescription(new RTCSessionDescription(offer));
    conn.remoteDescSet = true;
    await this._flushIce(peerId);
    const answer = await conn.pc.createAnswer();
    await conn.pc.setLocalDescription(answer);
    await sendAnswer(encKey, peerId, answer, relays);
  }

  async handleAnswer(peerId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    const conn = this._conns.get(peerId);
    if (!conn) return;
    await conn.pc.setRemoteDescription(new RTCSessionDescription(answer));
    conn.remoteDescSet = true;
    await this._flushIce(peerId);
  }

  async addIceCandidate(peerId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const conn = this._conns.get(peerId);
    if (!conn) return;
    if (!conn.remoteDescSet) conn.iceQueue.push(candidate);
    else await conn.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
  }

  private async _flushIce(peerId: string): Promise<void> {
    const conn = this._conns.get(peerId);
    if (!conn) return;
    for (const c of conn.iceQueue) await conn.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
    conn.iceQueue = [];
  }

  /** Send a JSON message to one peer. Returns false if the channel is not open. */
  send(peerId: string, payload: unknown): boolean {
    const conn = this._conns.get(peerId);
    if (!conn?.dc || conn.dc.readyState !== "open") return false;
    try {
      conn.dc.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  /** Send to every open peer; returns the count delivered. */
  broadcast(payload: unknown): number {
    const blob = JSON.stringify(payload);
    let n = 0;
    for (const conn of this._conns.values()) {
      if (conn.dc?.readyState === "open") {
        try {
          conn.dc.send(blob);
          n++;
        } catch {
          /* drop */
        }
      }
    }
    return n;
  }

  isConnected(peerId: string): boolean {
    const conn = this._conns.get(peerId);
    return conn?.dc?.readyState === "open" && conn.pc.connectionState === "connected";
  }

  connectedPeers(): string[] {
    const out: string[] = [];
    for (const [id, conn] of this._conns) if (conn.dc?.readyState === "open") out.push(id);
    return out;
  }

  /** Send a liveness ping over every open channel. A peer that stops emitting these
   *  (see msSinceHeard) is wedged even while its RTCPeerConnection still reads
   *  "connected" -- the case app-level dead-peer detection exists to catch. */
  pingAll(): void {
    const blob = JSON.stringify(HEARTBEAT_FRAME);
    for (const conn of this._conns.values()) {
      if (conn.dc?.readyState === "open") {
        try {
          conn.dc.send(blob);
        } catch {
          /* drop */
        }
      }
    }
  }

  /** Milliseconds since the last inbound datachannel frame from `peerId`, or Infinity
   *  if there is no open channel. Stays small while the peer pings / sends turns; it
   *  grows once the peer wedges, which the game reads to declare the peer dead. */
  msSinceHeard(peerId: string): number {
    const conn = this._conns.get(peerId);
    if (!conn || conn.dc?.readyState !== "open") return Infinity;
    return Date.now() - conn.lastHeard;
  }

  private _scheduleReconnect(peerId: string): void {
    const conn = this._conns.get(peerId);
    if (!conn || conn.reconnectTimer) return;
    if (DEVICE_ID > peerId) return; // only the initiator reconnects
    const delay = conn.backoff;
    conn.backoff = Math.min(conn.backoff * 2, MAX_BACKOFF_MS);
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      this._ensure(peerId, conn.encKey, conn.relays);
      this._createOffer(peerId).catch(() => {});
    }, delay);
  }

  private _cleanup(peerId: string, remove = true): void {
    const conn = this._conns.get(peerId);
    if (!conn) return;
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    try {
      conn.dc?.close();
    } catch {
      /* already closed */
    }
    try {
      conn.pc.close();
    } catch {
      /* already closed */
    }
    if (remove) this._conns.delete(peerId);
  }

  close(peerId: string): void {
    this._cleanup(peerId, true);
    this.onConnectionChange?.(peerId, "closed");
  }

  closeAll(): void {
    for (const id of [...this._conns.keys()]) this._cleanup(id, true);
  }
}
