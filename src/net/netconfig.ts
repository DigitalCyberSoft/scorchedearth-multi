// ───────────────────────────────────────────────────────────────────────────
// NET CONFIG — relays, kinds, STUN, and the well-known public-lobby key.
//
// Architecture (forked from ../tasktank's transport): peers talk over WebRTC data
// channels; the SDP offer/answer + ICE are signaled through Nostr ephemeral events
// on public relays. There is NO game server. A "room" is a shared 32-byte AES key:
// it encrypts every event's content AND (via SHA-256) derives a secp256k1 Nostr
// keypair, so everyone holding the key publishes/subscribes as the same identity.
//   - private match  -> a freshly generated room key, shared out-of-band (link/QR)
//   - public  match  -> announced on the FIXED PUBLIC_LOBBY_KEY channel below
//   - 24h metric      -> start events on the same public channel, counted by relay query
// ───────────────────────────────────────────────────────────────────────────

export const PROTOCOL_VERSION = 1;

/** Public Nostr relays used as the signaling rendezvous (mirrors tasktank). */
export const NOSTR_RELAYS: readonly string[] = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://relay.primal.net",
  "wss://nostr.mom",
  "wss://nostr.einundzwanzig.space",
  "wss://yabu.me",
  "wss://nostr.oxtr.dev",
  "wss://relay.mostr.pub",
  "wss://soloco.nl",
  "wss://nostr.data.haus",
  "wss://relay.nostr.net",
  "wss://relay.noswhere.com",
];

/** Public STUN (zero-config). Multiple servers + Cloudflare's so a single outage doesn't
 *  block gathering; STUN reflexive candidates traverse every NAT pair EXCEPT two symmetric
 *  NATs, which physically require a TURN relay (see TURN_SERVERS). */
export const STUN_SERVERS: RTCIceServer[] = [
  {
    urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:stun2.l.google.com:19302",
      "stun:stun.cloudflare.com:3478",
    ],
  },
];

/** TURN is OPT-IN. A pair of *symmetric* NATs cannot be hole-punched with STUN alone; only
 *  a TURN relay bridges them. There is NO reliable zero-signup public TURN (the Open Relay
 *  static-credential service is deprecated -- verified 2026-06-28: its hosts allocate no
 *  relay candidate). To make connectivity bulletproof, paste free-tier creds here (Metered
 *  ~50 GB/mo or Cloudflare ~1 TB/mo, both free to sign up) and rebuild, OR inject them at
 *  runtime with `?turn=<base64 of a JSON RTCIceServer or RTCIceServer[]>` (no rebuild).
 *  Empty => STUN-only, which already connects every NON-symmetric pair. */
export const TURN_SERVERS: RTCIceServer[] = [
  // Example -- replace with YOUR free-tier TURN creds, then `npm run build` + redeploy:
  // {
  //   urls: ["turn:relay.example.com:80", "turn:relay.example.com:80?transport=tcp",
  //          "turns:relay.example.com:443?transport=tcp"],
  //   username: "USERNAME", credential: "CREDENTIAL",
  // },
];

/** Runtime TURN override: ?turn=<base64(JSON)> where JSON is an RTCIceServer or an array
 *  of them. Lets a deployment (or the test harness) add TURN without a rebuild. */
function _turnOverride(): RTCIceServer[] {
  try {
    const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
    const raw = params.get("turn");
    if (!raw) return [];
    const parsed = JSON.parse(atob(raw)) as RTCIceServer | RTCIceServer[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return []; // malformed override: fall back to STUN + any compiled-in TURN
  }
}

/** The live ICE config: public STUN + any compiled-in TURN + any ?turn= override. Read at
 *  each RTCPeerConnection so a runtime override applies. */
export function rtcConfig(): RTCConfiguration {
  return { iceServers: [...STUN_SERVERS, ...TURN_SERVERS, ..._turnOverride()] };
}

// Nostr event kinds.
export const SIGNALING_KIND = 20078; // ephemeral: WebRTC signaling + room presence
export const LOBBY_KIND = 30078; // replaceable (NIP-78): public match announcements
export const STAT_KIND = 30078; // replaceable: per-device 24h start markers

// WebRTC data channel.
export const DC_LABEL = "scorch";
export const DC_CONFIG: RTCDataChannelInit = { ordered: true };

// Cadences (ms).
export const PRESENCE_INTERVAL_MS = 5_000; // Nostr room heartbeat (who is here)
export const ANNOUNCE_INTERVAL_MS = 15_000; // public-match announcement refresh
export const ANNOUNCE_TTL_MS = 60_000; // a public match silent longer than this is stale
// Datachannel liveness (P2P, distinct from the Nostr room heartbeat above). Peers
// ping each open channel every HEARTBEAT_INTERVAL_MS; a channel that delivers no
// frame (ping OR game traffic) for PEER_DEAD_MS is treated as dead even while the
// ICE layer still reports it "connected" -- the wedged-peer case ICE alone misses.
export const HEARTBEAT_INTERVAL_MS = 2_000;
export const PEER_DEAD_MS = 6_000; // 3 missed pings

/** FIXED shared key for the PUBLIC lobby channel + the global start metric. Anyone
 *  running the app derives the same Nostr identity from it -> a single public room
 *  everyone can read/write. (Generated once with crypto.randomBytes(32); rotating it
 *  partitions the public lobby, so treat it as a protocol constant.) */
export const PUBLIC_LOBBY_KEY = "tslTtEErFjpf4JWCsMu9VbLymvaYsy4d4Dr0xHNSp1A=";

// Relay override: lets a deployment (or the test harness, via ?relays=ws://...) point
// the app at a private/local relay instead of the public set. activeRelays() is read
// at every publish/subscribe so the override applies once set at boot.
let _relayOverride: readonly string[] | null = null;
export function setRelayOverride(urls: readonly string[] | null): void {
  _relayOverride = urls && urls.length > 0 ? urls : null;
}
export function activeRelays(): readonly string[] {
  return _relayOverride ?? NOSTR_RELAYS;
}

// Test hooks (window.__mp* telemetry + the __mpAutoFire driver) are gated OFF by
// default so production never ships the auto-fire console backdoor. main.ts enables
// them only when the page is loaded with ?test=1 (the multi-browser harness does so).
let _testHooks = false;
export function setTestHooks(on: boolean): void {
  _testHooks = on;
}
export function testHooks(): boolean {
  return _testHooks;
}
