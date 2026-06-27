// ───────────────────────────────────────────────────────────────────────────
// METRICS — best-effort "players who started a game in the last 24h", serverless.
//
// Each device writes ONE replaceable marker to the shared public channel, d-tag =
// `start:{deviceHash}` (latest start wins). Counting distinct devices whose last
// start is within 24h answers the question. This is BEST-EFFORT and explicitly
// untrusted: accuracy depends on relay retention/coverage, and because the public
// key is shared, the count is spoofable by anyone running the app. Do not treat it
// as authoritative analytics.
// ───────────────────────────────────────────────────────────────────────────
import { STAT_KIND, PUBLIC_LOBBY_KEY } from "./netconfig";
import { DEVICE_ID, sha256Hex } from "./identity";
import { publishReplaceable, queryReplaceable } from "./nostr";

interface StartMarker {
  ts: number;
  v: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Record that this device started a game. Never throws (metric must not block play). */
export async function recordGameStart(): Promise<void> {
  try {
    const hash = (await sha256Hex(DEVICE_ID)).slice(0, 16);
    await publishReplaceable(STAT_KIND, PUBLIC_LOBBY_KEY, `start:${hash}`, { ts: Date.now(), v: 1 } satisfies StartMarker);
  } catch {
    /* best-effort */
  }
}

/** Distinct devices whose most recent start was within the last 24h. */
export async function countPlayers24h(): Promise<number> {
  const cutoff = Date.now() - DAY_MS;
  const recs = await queryReplaceable<StartMarker>(STAT_KIND, PUBLIC_LOBBY_KEY);
  const devices = new Set<string>();
  for (const r of recs) {
    if (!r.dTag.startsWith("start:")) continue; // skip public-match announcements (same key)
    const ts = typeof r.data?.ts === "number" ? r.data.ts : r.createdAt * 1000;
    if (ts >= cutoff) devices.add(r.dTag);
  }
  return devices.size;
}
