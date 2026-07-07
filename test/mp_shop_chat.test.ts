// MP shop barrier + chat wire tests.
//
// The user-visible bug this locks against: the round advancing while a player is
// still ACTIVELY shopping. Root cause was a flat per-client wall-clock shop window:
// each client measured "60s since I entered the shop" on its own rAF clock, which
// freezes whenever Chrome occludes/backgrounds the window (dt is also clamped to
// 1/30s at main.ts step()), so one human playing several browsers sequentially had
// the host's window expire while they were mid-shop elsewhere. The barrier is now:
// advance on all-carts-in, or when EVERY missing player is idle past the allowance
// (host clock), or at an absolute anti-stall ceiling. shopBarrierReady is the pure
// decision; the wire messages are round-tagged and chat is sanitized+rate-limited.
import { describe, it, expect } from "vitest";
import { shopBarrierReady } from "../src/screens_mp_game";
import { LockstepSession, sanitizeChat, type EngineAdapter } from "../src/net/lockstep";
import type { Match } from "../src/net/match";

// ── shopBarrierReady (pure) ──────────────────────────────────────────────────

function barrier(over: Partial<Parameters<typeof shopBarrierReady>[0]> = {}) {
  return shopBarrierReady({
    humans: ["a", "b", "c"],
    submitted: new Set<string>(),
    idleMsOf: () => 0,
    idleLimitMs: 62_000,
    elapsedS: 10,
    ceilingS: 300,
    ...over,
  });
}

describe("shopBarrierReady", () => {
  it("fires all_in the moment every human's cart is in", () => {
    expect(barrier({ submitted: new Set(["a", "b", "c"]) })).toBe("all_in");
  });

  it("waits while anyone is missing and still active (the reported bug)", () => {
    // b submitted; a and c pending. c idle a long time, but a is ACTIVELY shopping:
    // the round MUST NOT advance (one person playing 3 browsers looks exactly like
    // this -- every seat they are not currently in appears idle).
    const idle = new Map([
      ["a", 1_000],
      ["c", 500_000],
    ]);
    expect(
      barrier({ submitted: new Set(["b"]), idleMsOf: (d) => idle.get(d) ?? 0 }),
    ).toBeNull();
  });

  it("fires idle only when EVERY pending player is past the allowance", () => {
    const idle = new Map([
      ["a", 70_000],
      ["c", 100_000],
    ]);
    expect(
      barrier({ submitted: new Set(["b"]), idleMsOf: (d) => idle.get(d) ?? 0 }),
    ).toBe("idle");
  });

  it("boundary: exactly at the allowance is NOT yet idle", () => {
    expect(barrier({ submitted: new Set(["b", "c"]), idleMsOf: () => 62_000 })).toBeNull();
    expect(barrier({ submitted: new Set(["b", "c"]), idleMsOf: () => 62_001 })).toBe("idle");
  });

  it("ceiling bounds a perpetually-active straggler", () => {
    expect(barrier({ submitted: new Set(["b"]), idleMsOf: () => 0, elapsedS: 300 })).toBe("ceiling");
    expect(barrier({ submitted: new Set(["b"]), idleMsOf: () => 0, elapsedS: 299 })).toBeNull();
  });

  it("no humans -> no decision", () => {
    expect(barrier({ humans: [] })).toBeNull();
  });
});

// ── sanitizeChat ─────────────────────────────────────────────────────────────

describe("sanitizeChat", () => {
  it("passes normal text, trims whitespace", () => {
    expect(sanitizeChat("  hello there  ")).toBe("hello there");
  });
  it("strips control characters (canvas text safety)", () => {
    expect(sanitizeChat("a\x00b\x1fc\x7fd\ne")).toBe("abcde");
  });
  it("caps at 120 chars", () => {
    expect(sanitizeChat("x".repeat(500)).length).toBe(120);
  });
  it("non-strings and empties become ''", () => {
    expect(sanitizeChat(42)).toBe("");
    expect(sanitizeChat(null)).toBe("");
    expect(sanitizeChat("\x01\x02")).toBe("");
  });
});

// ── wire: round tags, self-only senders, rate limits ─────────────────────────

interface Sent {
  msgs: unknown[];
}
function fakeMatch(hostId: string): { match: Match; sent: Sent; deliver: (peerId: string, msg: unknown) => void } {
  const sent: Sent = { msgs: [] };
  const handlers: { onMessage?: (peerId: string, msg: unknown) => void } = {};
  const match = {
    hostId,
    handlers,
    broadcast: (m: unknown) => sent.msgs.push(m),
    setStatus: () => undefined,
    players: () => [],
  } as unknown as Match;
  return { match, sent, deliver: (peerId, msg) => handlers.onMessage?.(peerId, msg) };
}
const nullAdapter: EngineAdapter = {
  startMatch: () => undefined,
  activeDeviceId: () => null,
  applyTurnInput: () => undefined,
  worldHash: () => "0",
  snapshot: () => null,
  restore: () => undefined,
};

describe("lockstep shop/chat wire", () => {
  it("delivers a round-tagged cart from its own peer; rejects forged/untagged ones", () => {
    const { match, deliver } = fakeMatch("H");
    const s = new LockstepSession(match, nullAdapter, "host");
    const got: Array<[string, number]> = [];
    s.onShopResult = (d, r) => got.push([d, r]);
    deliver("P1", { t: "shop", from: "P1", round: 2, inv: [1, 2], cash: 50 });
    deliver("P1", { t: "shop", from: "P2", round: 2, inv: [1], cash: 5 }); // impersonation
    deliver("P1", { t: "shop", from: "P1", inv: [1], cash: 5 }); // untagged (pre-fix client)
    deliver("P1", { t: "shop", from: "P1", round: 2.5, inv: [1], cash: 5 }); // non-integer
    deliver("P1", { t: "shop", from: "P1", round: -1, inv: [1], cash: 5 }); // negative
    expect(got).toEqual([["P1", 2]]);
  });

  it("shopact: self-only, round-tagged, rate-limited per peer", () => {
    const { match, deliver } = fakeMatch("H");
    const s = new LockstepSession(match, nullAdapter, "host");
    let n = 0;
    s.onShopActivity = () => n++;
    deliver("P1", { t: "shopact", from: "P1", round: 1 });
    deliver("P1", { t: "shopact", from: "P1", round: 1 }); // same ms -> rate-limited
    deliver("P1", { t: "shopact", from: "P2", round: 1 }); // impersonation
    expect(n).toBe(1);
  });

  it("shopfin: host-only and round-tagged", () => {
    const { match, deliver } = fakeMatch("H");
    const s = new LockstepSession(match, nullAdapter, "guest");
    const got: number[] = [];
    s.onShopFinal = (r) => got.push(r);
    deliver("H", { t: "shopfin", round: 3, results: {} });
    deliver("P2", { t: "shopfin", round: 3, results: {} }); // not the host
    deliver("H", { t: "shopfin", results: {} }); // untagged
    expect(got).toEqual([3]);
  });

  it("chat: sanitized, self-only, rate-limited; sendChat sanitizes too", () => {
    const { match, sent, deliver } = fakeMatch("H");
    const s = new LockstepSession(match, nullAdapter, "guest");
    const got: string[] = [];
    s.onChat = (_d, t) => got.push(t);
    deliver("P1", { t: "chat", from: "P1", text: "  hi\x00 there " });
    deliver("P1", { t: "chat", from: "P1", text: "too fast" }); // same ms -> dropped
    deliver("P1", { t: "chat", from: "P2", text: "forged" }); // impersonation
    deliver("P1", { t: "chat", from: "P1", text: 7 }); // not a string
    expect(got).toEqual(["hi there"]);

    s.sendChat("  yo\x1f  ");
    s.sendChat("\x00"); // nothing displayable -> not sent
    const chats = sent.msgs.filter((m) => (m as { t: string }).t === "chat");
    expect(chats).toEqual([{ t: "chat", from: expect.any(String), text: "yo" }]);
  });
});
