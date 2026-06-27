// ───────────────────────────────────────────────────────────────────────────
// SIM DRIVER — deterministic, headless, fixed-dt stepper around a GameState.
//
// Lockstep requires every client to advance the simulation IDENTICALLY. The engine
// integrates projectile flight on a fixed substep (dt-independent), but several
// gates consume dt (TURN_START AI delay, parachute descent, speech linger), so the
// driver ALWAYS steps with FIXED_DT and never wall-clock time. AI turns auto-resolve
// (the engine fires them in TURN_START), so only human turns need an input; the
// driver runs to the next human turn / shop / game-over on its own.
//
// Targets the default SEQUENTIAL play mode. The shop transition is exposed as a
// single host-triggered call (advanceShop) so the lockstep layer can gate it behind
// a timer (see net/lockstep shop coordination).
// ───────────────────────────────────────────────────────────────────────────
import { createGameState, GameState, AIM, ROUND_END, SHOP, GAME_OVER } from "../game";
import { Config } from "../config";
import * as C from "../constants";
import { NUM_ITEMS } from "../weapons";
import type { MatchStart, TurnInput } from "./lockstep";

export const FIXED_DT = 1 / 60;

/** Clamp untrusted turn input to engine-valid ranges, deterministically: every client
 *  feeds the same wire bytes through this, so it cannot cause divergence. Guards
 *  NaN/Infinity (Math.trunc(NaN)=NaN would otherwise reach the integrator as a NaN
 *  velocity that never rests -> the flight hangs every client) and an out-of-range
 *  weapon index (defense-in-depth; the engine's has_ammo already rejects it today). */
export function sanitizeTurnInput(input: TurnInput): { angle: number; power: number; weapon: number } {
  const clamp = (v: unknown, lo: number, hi: number): number => {
    const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : lo;
    return Math.max(lo, Math.min(hi, n));
  };
  return {
    angle: clamp(input.angle, 0, 180),
    power: clamp(input.power, 0, 1000),
    weapon: clamp(input.weapon, 0, NUM_ITEMS - 1),
  };
}
const FRAME_GUARD = 200_000; // per-advance safety bound (a turn that never resolves)

export type StopReason = "await_input" | "shop" | "game_over";

export class SimDriver {
  readonly gs: GameState;
  readonly order: string[] = []; // tank index -> deviceId (add_player order)

  constructor(start: MatchStart) {
    const cfg = Object.assign(new Config(), start.cfg) as Config;
    this.gs = createGameState(cfg, start.w, start.h, start.seed);
    for (const s of start.order) {
      this.gs.add_player(s.name, s.aiClass, 0, s.tankIcon);
      this.order.push(s.deviceId);
    }
    this.gs.new_game();
  }

  phase(): string {
    return this.gs.phase;
  }
  roundIndex(): number {
    return this.gs.round_index;
  }
  activeIsHuman(): boolean {
    const t = this.gs.current_shooter;
    return !!t && t.ai_class === C.AI_HUMAN;
  }
  activeDeviceId(): string | null {
    const t = this.gs.current_shooter;
    if (!t) return null;
    const i = this.gs.tanks.indexOf(t);
    return i >= 0 ? (this.order[i] ?? null) : null;
  }
  worldHash(): string {
    return worldHash(this.gs);
  }

  /** Step on FIXED_DT until the next decision point (human input / shop / game over).
   *  ROUND_END is handled internally (proceed_after_round -> SHOP or GAME_OVER). */
  advance(): StopReason {
    let frames = 0;
    for (;;) {
      const p = this.gs.phase;
      if (p === GAME_OVER) return "game_over";
      if (p === SHOP) return "shop";
      if (p === ROUND_END) {
        this.gs.proceed_after_round();
        continue;
      }
      if (p === AIM && this.activeIsHuman()) return "await_input";
      if (frames++ > FRAME_GUARD) throw new Error(`sim_driver: frame guard exceeded in phase ${p}`);
      this.gs.update(FIXED_DT);
    }
  }

  /** Active human commits their turn: apply aim+fire, then run to the next stop. */
  submitInput(input: TurnInput): StopReason {
    const t = this.gs.current_shooter;
    if (t) {
      const s = sanitizeTurnInput(input);
      t.angle = s.angle;
      t.power = s.power;
      t.selected_weapon = s.weapon;
      this.gs.fire(t);
    }
    return this.advance();
  }

  /** Host shop-timer expiry (or all-ready): AI buys, then start the next round. */
  advanceShop(): StopReason {
    this.gs.run_ai_buys();
    this.gs.begin_next_round();
    return this.advance();
  }
}

/** FNV-1a 32-bit over the simulation-relevant world state. Identical across clients
 *  for a converged turn; any difference is a desync. */
export function worldHash(gs: GameState): string {
  let h = 0x811c9dc5;
  const mix = (b: number): void => {
    h ^= b & 0xff;
    h = Math.imul(h, 0x01000193);
  };
  const mixInt = (n: number): void => {
    n = n | 0;
    mix(n);
    mix(n >> 8);
    mix(n >> 16);
    mix(n >> 24);
  };
  const grid = gs.terrain.grid;
  for (let i = 0; i < grid.length; i++) mix(grid[i]);
  for (const t of gs.tanks) {
    mixInt(Math.trunc(t.x));
    mixInt(Math.trunc(t.y));
    mixInt(t.angle | 0);
    mixInt(t.power | 0);
    mixInt(t.selected_weapon | 0);
    mixInt(Math.trunc(t.health));
    mix(t.alive ? 1 : 0);
  }
  mixInt(gs.round_index | 0);
  mixInt(gs.fire_index | 0);
  return (h >>> 0).toString(16).padStart(8, "0");
}
