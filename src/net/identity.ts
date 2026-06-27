// ───────────────────────────────────────────────────────────────────────────
// IDENTITY — a stable per-browser device id + small helpers. NOT engine code, so
// Date.now()/Math.random() are fine here (the sim RNG stays seeded; see rng.ts).
// ───────────────────────────────────────────────────────────────────────────

const DID_KEY = "se-multi-did";

/** Short random token. */
export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function readDeviceId(): string {
  let d: string | null = null;
  try {
    d = localStorage.getItem(DID_KEY);
  } catch {
    d = null;
  }
  if (!d) {
    d = uid() + "-" + uid();
    try {
      localStorage.setItem(DID_KEY, d);
    } catch {
      /* private mode / no storage: ephemeral id for this session */
    }
  }
  return d;
}

/** This browser's stable device id (ephemeral if storage is blocked). */
export const DEVICE_ID = typeof window !== "undefined" ? readDeviceId() : "node";

/** Unix seconds (Nostr created_at unit). */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Lowercase hex SHA-256 of a string (used to pseudonymize the device id in the
 *  public start metric so raw ids never hit a relay). */
export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
