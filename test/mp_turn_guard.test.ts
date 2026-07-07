// Turn-timeout guard + shop-wait ETA (pure decision functions, screens_mp_game).
//
// User-reported defects these lock against:
//   - "You are still killing tanks if they miss their turn": the old guard read
//     heartbeat SILENCE as departure and committed a RETREAT (gs.retreat removes
//     the tank through the kill path). Chrome throttles a hidden window's timers
//     to 1/min after ~5 min, so a merely-backgrounded player went silent and was
//     killed at their next turn. Rule now: silence can only ever cost the TURN
//     (skip); only a CLOSED transport (the player left) costs the round.
//   - "The turn reset timer doesn't reset to 30 seconds": the old host stand-in
//     fired at 5x turnSeconds (150 s), so the countdown pinned at 0 for minutes.
//     The stand-in now fires at turnSeconds + TURN_GRACE_SECONDS.
//   - "no indication when you are waiting for another player at the shop":
//     shopWaitEta feeds the on-screen "continues in <=Ns" estimate.
import { describe, it, expect } from "vitest";
import { turnGuard, shopWaitEta, type TurnGuardState } from "../src/screens_mp_game";

const BASE: TurnGuardState = {
  myTurn: false,
  isHost: true,
  elapsedS: 0,
  turnSeconds: 30,
  graceS: 8,
  active: { remoteHuman: true, connected: true, silentMs: 0 },
  peerDeadMs: 6000,
  cpuApproved: false,
};
const g = (over: Partial<TurnGuardState>): ReturnType<typeof turnGuard> => turnGuard({ ...BASE, ...over });

describe("turnGuard: my own turn (self-enforced)", () => {
  it("holds through the full allowance", () => {
    expect(g({ myTurn: true, elapsedS: 0 })).toBeNull();
    expect(g({ myTurn: true, elapsedS: 29.9 })).toBeNull();
    expect(g({ myTurn: true, elapsedS: 30 })).toBeNull(); // strict >
  });
  it("self-skips past the allowance (host or guest alike)", () => {
    expect(g({ myTurn: true, elapsedS: 30.1 })).toBe("self_skip");
    expect(g({ myTurn: true, isHost: false, elapsedS: 30.1 })).toBe("self_skip");
  });
  it("never retreats itself, no matter the roster state", () => {
    expect(g({ myTurn: true, elapsedS: 500, active: null })).toBe("self_skip");
  });
});

describe("turnGuard: host stand-in for the active player", () => {
  it("non-hosts never stand in", () => {
    expect(g({ isHost: false, elapsedS: 500, active: { remoteHuman: true, connected: false, silentMs: 1e9 } })).toBeNull();
  });
  it("no active player -> nothing to enforce", () => {
    expect(g({ active: null, elapsedS: 500 })).toBeNull();
  });
  it("present and inside allowance+grace -> wait", () => {
    expect(g({ elapsedS: 37.9 })).toBeNull();
    expect(g({ elapsedS: 38 })).toBeNull(); // strict >
  });
  it("idle past allowance+grace -> SKIP, never a kill", () => {
    expect(g({ elapsedS: 38.1 })).toBe("skip");
  });
  it("SILENT but transport-open (hidden/wedged window) -> still only a SKIP", () => {
    // The regression: this exact state used to retreat (kill) the tank.
    expect(g({ elapsedS: 38.1, active: { remoteHuman: true, connected: true, silentMs: 120_000 } })).toBe("skip");
    // ...and silence alone never triggers anything EARLY either.
    expect(g({ elapsedS: 10, active: { remoteHuman: true, connected: true, silentMs: 120_000 } })).toBeNull();
  });
  it("transport CLOSED + silent past the dead threshold -> the player left: RETREAT", () => {
    expect(g({ elapsedS: 1, active: { remoteHuman: true, connected: false, silentMs: 6001 } })).toBe("retreat");
  });
  it("transport closed but recently heard (ICE blip) -> not gone; normal skip rules", () => {
    expect(g({ elapsedS: 10, active: { remoteHuman: true, connected: false, silentMs: 3000 } })).toBeNull();
    expect(g({ elapsedS: 38.1, active: { remoteHuman: true, connected: false, silentMs: 3000 } })).toBe("skip");
  });
  it("approved CPU replacement converts a departed player at the eviction", () => {
    expect(g({ cpuApproved: true, elapsedS: 1, active: { remoteHuman: true, connected: false, silentMs: 6001 } })).toBe("retreat_convert");
  });
  it("approved CPU replacement also converts a wedged-but-connected player at the skip bound", () => {
    expect(g({ cpuApproved: true, elapsedS: 38.1, active: { remoteHuman: true, connected: true, silentMs: 120_000 } })).toBe("retreat_convert");
  });
  it("approval alone never converts a LIVE player (heartbeating, just idle)", () => {
    expect(g({ cpuApproved: true, elapsedS: 38.1, active: { remoteHuman: true, connected: true, silentMs: 500 } })).toBe("skip");
  });
  it("an AI slot (no peer: silentMs Infinity) can never be retreated, only backstop-skipped", () => {
    const ai = { remoteHuman: false, connected: false, silentMs: Infinity };
    expect(g({ elapsedS: 10, active: ai })).toBeNull();
    expect(g({ elapsedS: 38.1, active: ai })).toBe("skip");
    expect(g({ cpuApproved: true, elapsedS: 38.1, active: ai })).toBe("skip");
  });
});

describe("shopWaitEta", () => {
  it("nothing pending -> 0", () => {
    expect(shopWaitEta({ pendingIdleMs: [], idleLimitMs: 15000, elapsedS: 0, ceilingS: 300 })).toBe(0);
  });
  it("one fresh shopper -> the full idle allowance", () => {
    expect(shopWaitEta({ pendingIdleMs: [0], idleLimitMs: 15000, elapsedS: 0, ceilingS: 300 })).toBe(15);
  });
  it("the LEAST idle pending shopper binds (any activity keeps the barrier)", () => {
    expect(shopWaitEta({ pendingIdleMs: [14000, 3000], idleLimitMs: 15000, elapsedS: 0, ceilingS: 300 })).toBe(12);
  });
  it("the absolute ceiling caps the estimate", () => {
    expect(shopWaitEta({ pendingIdleMs: [0], idleLimitMs: 60000, elapsedS: 295, ceilingS: 300 })).toBe(5);
  });
  it("everything overdue clamps to 0 (the barrier is about to fire)", () => {
    expect(shopWaitEta({ pendingIdleMs: [20000], idleLimitMs: 15000, elapsedS: 0, ceilingS: 300 })).toBe(0);
    expect(shopWaitEta({ pendingIdleMs: [0], idleLimitMs: 15000, elapsedS: 400, ceilingS: 300 })).toBe(0);
  });
});
