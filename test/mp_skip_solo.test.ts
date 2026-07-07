// Turn-timeout SKIP semantics + post-desync solo detach.
//
// User-reported defect this locks against: a player whose turn timer expired was
// KILLED -- the old timeout committed a retreat turn, and gs.retreat() removes the
// tank through the kill path (death blast and all). The intended rule: a timeout
// forfeits ONLY THE TURN. The tank stays alive and in the round; play passes to
// the next shooter. Retreat is reserved for players who actually DISCONNECTED
// (dead-peer eviction / CPU replacement).
//
// Also locks the desync degrade path: ANY client (host or guest, and even the
// slower one whose own hash computes after the peer's arrives) must detect a
// divergence, and a detached session must go chat-only in both directions.
import { describe, it, expect } from "vitest";
import { SimDriver, sanitizeTurnInput } from "../src/net/sim_driver";
import { LockstepSession, type EngineAdapter, type TurnInput } from "../src/net/lockstep";
import type { MatchStart, PlayerSlot } from "../src/net/lockstep";
import type { Match } from "../src/net/match";

function start(seed: number, order: PlayerSlot[], cfg: Record<string, unknown> = {}): MatchStart {
  return { seed, w: 1024, h: 768, cfg: { MAXROUNDS: 5, INITIAL_CASH: 0, ...cfg }, order };
}
function humans(n: number): PlayerSlot[] {
  return Array.from({ length: n }, (_, i) => ({ deviceId: `dev${i}`, name: `P${i}`, tankIcon: i % 7, aiClass: 0 }));
}
const fire = (angle = 45, power = 500): TurnInput => ({ angle, power, weapon: 0, moves: [] });
const skip: TurnInput = { angle: 0, power: 0, weapon: 0, moves: [], skip: true };
const retreat: TurnInput = { angle: 0, power: 0, weapon: 0, moves: [], retreat: true };

// ── sanitize ─────────────────────────────────────────────────────────────────

describe("sanitizeTurnInput: skip", () => {
  it("is a strict boolean (any other shape means fire)", () => {
    expect(sanitizeTurnInput(skip).skip).toBe(true);
    expect(sanitizeTurnInput(fire()).skip).toBe(false);
    expect(sanitizeTurnInput({ ...fire(), skip: 1 as unknown as boolean }).skip).toBe(false);
    expect(sanitizeTurnInput({ ...fire(), skip: "true" as unknown as boolean }).skip).toBe(false);
  });
});

// ── engine semantics: skip vs retreat ────────────────────────────────────────

describe("skip turn (timeout) vs retreat (disconnect)", () => {
  it("a skipped turn keeps the tank ALIVE and passes play to the next shooter", () => {
    const d = new SimDriver(start(1234, humans(2)));
    expect(d.advance()).toBe("await_input");
    const first = d.activeDeviceId();
    const round0 = d.roundIndex();
    expect(d.gs.tanks.filter((t) => t.alive).length).toBe(2);

    expect(d.submitInput(skip)).toBe("await_input");
    expect(d.gs.tanks.filter((t) => t.alive).length).toBe(2); // NOBODY died
    expect(d.activeDeviceId()).not.toBe(first); // play moved on
    expect(d.roundIndex()).toBe(round0); // same round, not a round forfeit

    // Round-robin returns to the skipper: they only lost the one turn.
    expect(d.submitInput(skip)).toBe("await_input");
    expect(d.activeDeviceId()).toBe(first);
    expect(d.gs.tanks.filter((t) => t.alive).length).toBe(2);
  });

  it("retreat still removes the tank for the round (the disconnect path)", () => {
    const d = new SimDriver(start(99, humans(3)));
    expect(d.advance()).toBe("await_input");
    expect(d.gs.tanks.filter((t) => t.alive).length).toBe(3);
    expect(d.submitInput(retreat)).toBe("await_input"); // 2 alive -> round continues
    expect(d.gs.tanks.filter((t) => t.alive).length).toBe(2);
  });

  it("skips are deterministic: identical seed+inputs give identical hash traces", () => {
    const trace = (): string[] => {
      const d = new SimDriver(start(777, humans(2)));
      const seq: string[] = [];
      let r = d.advance();
      for (let turn = 0; turn < 12 && r === "await_input"; turn++) {
        seq.push(`${d.activeDeviceId()}:${d.worldHash()}`);
        r = d.submitInput(turn % 3 === 0 ? skip : fire(30 + turn * 7, 400 + turn * 20));
      }
      seq.push(`end:${d.phase()}:${d.worldHash()}`);
      return seq;
    };
    const a = trace(); // sequential runs: the sim RNG is a module singleton
    const b = trace();
    expect(a.length).toBeGreaterThan(3);
    expect(b).toEqual(a);
  });
});

// ── wire: host stand-in accepts skip, never a fire ───────────────────────────

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
function recordingAdapter(active: string, hash: () => string): { adapter: EngineAdapter; applied: TurnInput[] } {
  const applied: TurnInput[] = [];
  const adapter: EngineAdapter = {
    startMatch: () => undefined,
    activeDeviceId: () => active,
    applyTurnInput: (i) => void applied.push(i),
    worldHash: hash,
    snapshot: () => null,
    restore: () => undefined,
  };
  return { adapter, applied };
}

describe("lockstep wire: skip stand-in + detach + symmetric desync", () => {
  it("tryPump takes a host stand-in only with skip/retreat set, never a fire", () => {
    const { match, deliver } = fakeMatch("H");
    const { adapter, applied } = recordingAdapter("P1", () => "0");
    const s = new LockstepSession(match, adapter, "guest");
    deliver("H", { t: "turn", n: 1, from: "H", input: fire() }); // host tries to fire for P1
    expect(s.tryPump()).toBe(false);
    expect(applied).toEqual([]);
    deliver("H", { t: "turn", n: 1, from: "H", input: skip }); // stuck-client skip
    expect(s.tryPump()).toBe(true);
    expect(applied.length).toBe(1);
    expect(applied[0].skip).toBe(true);
  });

  it("detach: game traffic dead both ways, chat alive, commitTurn applies locally", () => {
    const { match, sent, deliver } = fakeMatch("H");
    const { adapter, applied } = recordingAdapter("me", () => "0");
    const s = new LockstepSession(match, adapter, "guest");
    const chats: string[] = [];
    s.onChat = (_d, t) => chats.push(t);
    let shopSeen = 0;
    s.onShopResult = () => shopSeen++;
    s.detach();

    deliver("P1", { t: "turn", n: 1, from: "P1", input: fire() }); // ignored
    expect(s.tryPump()).toBe(false);
    deliver("P1", { t: "shop", from: "P1", round: 0, inv: [], cash: 1 }); // ignored
    expect(shopSeen).toBe(0);
    deliver("P1", { t: "chat", from: "P1", text: "still here" }); // chat survives
    expect(chats).toEqual(["still here"]);

    s.sendShop(0, [], 0);
    s.sendShopActivity(0);
    s.sendControl("x");
    s.commitTurn(fire()); // applies locally, no broadcast
    expect(applied.length).toBe(1);
    expect(sent.msgs.filter((m) => (m as { t: string }).t !== "chat")).toEqual([]);
    s.sendChat("hi"); // outbound chat still flows
    expect(sent.msgs.filter((m) => (m as { t: string }).t === "chat").length).toBe(1);
  });

  it("a GUEST detects a divergence too, even when the peer's hash arrives first", () => {
    const { match, deliver } = fakeMatch("H");
    const { adapter } = recordingAdapter("me", () => "AAA");
    const s = new LockstepSession(match, adapter, "guest");
    const flagged: Array<[number, string]> = [];
    s.onDesync = (n, p) => flagged.push([n, p]);

    // Fast peer: its hash for turn 1 lands before we've applied turn 1.
    deliver("H", { t: "hash", n: 1, from: "H", hash: "BBB" });
    expect(flagged).toEqual([]); // nothing to compare against yet
    s.commitTurn(fire()); // we apply turn 1 -> our hash "AAA" -> sweep flags it
    expect(flagged).toEqual([[1, "H"]]);

    // Slow peer: a hash arriving after we applied is judged immediately.
    deliver("H", { t: "hash", n: 1, from: "H", hash: "CCC" });
    expect(flagged.length).toBe(2);
  });

  it("matching hashes never flag", () => {
    const { match, deliver } = fakeMatch("H");
    const { adapter } = recordingAdapter("me", () => "AAA");
    const s = new LockstepSession(match, adapter, "guest");
    let flags = 0;
    s.onDesync = () => flags++;
    deliver("H", { t: "hash", n: 1, from: "H", hash: "AAA" }); // early, matching
    s.commitTurn(fire());
    deliver("H", { t: "hash", n: 1, from: "H", hash: "AAA" }); // late, matching
    expect(flags).toBe(0);
  });
});
