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

/** STUN only (no TURN): NAT hole-punching works for most peer pairs but FAILS for
 *  some symmetric-NAT pairs. A TURN relay is the later fix; see README "Limits". */
export const STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];
export const RTC_CONFIG: RTCConfiguration = { iceServers: STUN_SERVERS };

// Nostr event kinds.
export const SIGNALING_KIND = 20078; // ephemeral: WebRTC signaling + room presence
export const LOBBY_KIND = 30078; // replaceable (NIP-78): public match announcements
export const STAT_KIND = 30078; // replaceable: per-device 24h start markers

// WebRTC data channel.
export const DC_LABEL = "scorch";
export const DC_CONFIG: RTCDataChannelInit = { ordered: true };

// Cadences (ms).
export const PRESENCE_INTERVAL_MS = 5_000; // room heartbeat (who is here)
export const ANNOUNCE_INTERVAL_MS = 15_000; // public-match announcement refresh
export const ANNOUNCE_TTL_MS = 60_000; // a public match silent longer than this is stale

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
