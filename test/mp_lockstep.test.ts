// Lockstep determinism stress test (in-process).
//
// The sim RNG is a module-level singleton (game.ts:251), so N GameStates cannot run
// concurrently in one process -- but each real client is its own browser process, so
// the property that matters is REPRODUCIBILITY: the same seed + same inputs must
// produce a byte-identical game every time. We prove it by running each match many
// times (reseeded) and asserting identical world-hash sequences across runs and
// across many turns and rounds. Any hidden nondeterminism (Math.random/Date.now in
// the sim, iteration-order, uninitialized global state) breaks these.
//
// FINDING (documented, not a netcode bug): with CHANGING_WIND off, two surviving
// AI_SHOOTER bots compute the identical missing shot every turn and stalemate
// forever -- faithful, deterministic engine behavior. Multi-bot tests therefore run
// with CHANGING_WIND on (shots vary -> rounds terminate); the stalemate itself is
// pinned by `staleMate` below, and motivates the round/turn timeout (net task #40).
import { describe, it, expect } from "vitest";
import { SimDriver, FIXED_DT, type StopReason } from "../src/net/sim_driver";
import * as C from "../src/constants";
import type { MatchStart, PlayerSlot, TurnInput } from "../src/net/lockstep";

function start(seed: number, order: PlayerSlot[], cfg: Record<string, unknown> = {}): MatchStart {
  return { seed, w: 1024, h: 768, cfg: { MAXROUNDS: 5, ...cfg }, order };
}
function slots(n: number, aiClass: number): PlayerSlot[] {
  return Array.from({ length: n }, (_, i) => ({ deviceId: `dev${i}`, name: `P${i}`, tankIcon: i % 7, aiClass }));
}
function strHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}
/** Deterministic per-turn input from (turn, deviceId): every client computes the
 *  SAME value, which is exactly what the lockstep broadcast guarantees. */
function scriptedInput(turn: number, deviceId: string): TurnInput {
  const k = (Math.imul(turn + 1, 2654435761) ^ strHash(deviceId)) >>> 0;
  return { angle: 15 + (k % 150), power: 300 + ((k >>> 8) % 650), weapon: 0, moves: [] };
}

interface RunOpts {
  input?: (turn: number, deviceId: string) => TurnInput;
  turnCap?: number;
}
/** Run a match to game-over (or turnCap human turns), returning the world-hash trace. */
function runMatch(s: MatchStart, opts: RunOpts = {}): string[] {
  const d = new SimDriver(s);
  const seq: string[] = [`init:${d.worldHash()}`];
  const turnCap = opts.turnCap ?? 100000;
  let turn = 0;
  let r: StopReason = d.advance();
  while (r !== "game_over") {
    if (r === "await_input") {
      const dev = d.activeDeviceId() ?? "?";
      seq.push(`aim:${dev}@r${d.roundIndex()}:${d.worldHash()}`);
      const inp = opts.input ? opts.input(turn, dev) : { angle: 45, power: 500, weapon: 0, moves: [] };
      turn++;
      r = d.submitInput(inp);
      if (turn >= turnCap) break;
    } else {
      seq.push(`shop@r${d.roundIndex()}:${d.worldHash()}`);
      r = d.advanceShop();
    }
    seq.push(`${d.phase()}@r${d.roundIndex()}:${d.worldHash()}`);
  }
  seq.push(`end:${d.phase()}@r${d.roundIndex()}:${d.worldHash()}`);
  return seq;
}
/** Frame-bounded trace (for the non-terminating stalemate): sample the hash while
 *  stepping a fixed number of frames. Proves determinism without termination. */
function runFrames(s: MatchStart, nFrames: number, sampleEvery = 4000): string[] {
  const d = new SimDriver(s);
  const gs = d.gs as unknown as {
    phase: string;
    round_index: number;
    proceed_after_round(): void;
    run_ai_buys(): void;
    begin_next_round(): void;
    update(dt: number): void;
  };
  const seq: string[] = [];
  let reachedGameOver = false;
  for (let f = 0; f < nFrames; f++) {
    const p = gs.phase;
    if (p === "game_over") { reachedGameOver = true; break; }
    if (p === "round_end") { gs.proceed_after_round(); continue; }
    if (p === "shop") { gs.run_ai_buys(); gs.begin_next_round(); continue; }
    if (f % sampleEvery === 0) seq.push(`${p}@r${gs.round_index}:${d.worldHash()}`);
    gs.update(FIXED_DT);
  }
  seq.push(`gameover=${reachedGameOver}`);
  return seq;
}

describe("lockstep determinism (reproducibility == cross-client convergence)", () => {
  it("2-player AI, 5 rounds: byte-identical across 5 runs, runs to completion", () => {
    const s = start(0xc0ffee, slots(2, C.AI_SHOOTER), { MAXROUNDS: 5, CHANGING_WIND: "ON" });
    const runs = Array.from({ length: 5 }, () => runMatch(s));
    for (let i = 1; i < runs.length; i++) expect(runs[i]).toEqual(runs[0]);
    expect(runs[0].some((l) => l.startsWith("shop@"))).toBe(true);
    expect(runs[0].some((l) => l.startsWith("end:game_over"))).toBe(true);
  });

  it("3-player AI, 5 rounds (matches the 3-browser target): reproduces exactly + completes", () => {
    const s = start(0x3b0a7, slots(3, C.AI_SHOOTER), { MAXROUNDS: 5, CHANGING_WIND: "ON" });
    const runs = Array.from({ length: 3 }, () => runMatch(s));
    for (let i = 1; i < runs.length; i++) expect(runs[i]).toEqual(runs[0]);
    expect(runs[0].some((l) => l.startsWith("end:game_over"))).toBe(true);
  });

  it("human-input match converges when every client applies the same per-turn input", () => {
    const s = start(0x5eed, slots(3, C.AI_HUMAN), { MAXROUNDS: 3 });
    const runs = Array.from({ length: 3 }, () => runMatch(s, { input: scriptedInput, turnCap: 60 }));
    for (let i = 1; i < runs.length; i++) expect(runs[i]).toEqual(runs[0]);
    expect(runs[0].filter((l) => l.startsWith("aim:")).length).toBeGreaterThan(5);
  });

  it("mixed human+AI match reproduces exactly", () => {
    const order: PlayerSlot[] = [
      { deviceId: "h0", name: "Human", tankIcon: 0, aiClass: C.AI_HUMAN },
      { deviceId: "a1", name: "Bot", tankIcon: 1, aiClass: C.AI_SHOOTER },
    ];
    const s = start(0x99887766, order, { MAXROUNDS: 3, CHANGING_WIND: "ON" });
    const runs = Array.from({ length: 3 }, () => runMatch(s, { input: scriptedInput, turnCap: 40 }));
    for (let i = 1; i < runs.length; i++) expect(runs[i]).toEqual(runs[0]);
  });

  it("stalemate (4-player, wind off) is deterministic and does NOT terminate -> needs a round timeout", () => {
    const s = start(0x1234abcd, slots(4, C.AI_SHOOTER), { MAXROUNDS: 2, CHANGING_WIND: "OFF" });
    const runs = Array.from({ length: 3 }, () => runFrames(s, 60000));
    for (let i = 1; i < runs.length; i++) expect(runs[i]).toEqual(runs[0]);
    expect(runs[0][runs[0].length - 1]).toBe("gameover=false"); // confirmed stalemate within the bound
  });

  it("sanity: different seeds produce different games (the hash is not constant)", () => {
    expect(runMatch(start(1, slots(2, C.AI_SHOOTER), { CHANGING_WIND: "ON" }))).not.toEqual(
      runMatch(start(2, slots(2, C.AI_SHOOTER), { CHANGING_WIND: "ON" })),
    );
  });
});
