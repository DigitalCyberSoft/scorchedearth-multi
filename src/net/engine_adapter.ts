// ───────────────────────────────────────────────────────────────────────────
// ENGINE ADAPTER — binds the lockstep layer to the real game engine (game.ts).
//
// WIRED (real): startMatch (seed + roster + new_game), activeDeviceId, worldHash,
// and a minimal applyTurnInput (aim + fire on the active tank).
// NOT YET WIRED (honest stubs, see README "Multiplayer status"):
//   - applyTurnInput does NOT yet drive pre-fire tank moves, nor does it gate the
//     post-fire projectile animation in lockstep (the engine resolves projectiles
//     deterministically in its own loop; hashing must happen AFTER they rest, which
//     the game-loop integration will own).
//   - snapshot/restore: authoritative resync is detected but not auto-healed yet;
//     wiring is savegame.serialize/apply PLUS the MT19937 stream position.
// ───────────────────────────────────────────────────────────────────────────
import { createGameState, GameState } from "../game";
import { Config } from "../config";
import * as C from "../constants";
import { NUM_ITEMS } from "../weapons";
import * as diag from "../diag";
import { recordGameStart } from "./metrics";
import { worldHash, sanitizeTurnInput } from "./sim_driver";
import type { EngineAdapter, MatchStart, TurnInput, ShopResult } from "./lockstep";

/** Minimal shop-relevant view of a tank (objects.ts: cash +0xbe, inventory *(tank+0xb2)). */
interface TankShape {
  ai_class: number;
  cash: number;
  inventory: number[];
}

export interface GameEngineAdapter extends EngineAdapter {
  /** The live GameState (null before startMatch), for the renderer/HUD to draw. */
  state(): GameState | null;
  /** Device ids in tank order (add_player order). */
  deviceIds(): string[];
  /** Device ids of the human tanks (the ones that shop between rounds). */
  humanDeviceIds(): string[];
  /** The tank object for a device id (for the local shop UI), or null. */
  tankOf(deviceId: string): unknown;
  /** Snapshot a tank's post-shop state (inventory + cash), or null. */
  shopSnapshot(deviceId: string): ShopResult | null;
  /** Overwrite a tank's inventory + cash from an authoritative snapshot (clamped). */
  applyShopSnapshot(deviceId: string, snap: ShopResult): void;
  /** Resolve the shop: AI buys (deterministic) then start the next round. */
  finishShop(): void;
}

export function createEngineAdapter(): GameEngineAdapter {
  let gs: GameState | null = null;
  let order: string[] = []; // tank index -> deviceId (add_player order)

  const tankAt = (deviceId: string): TankShape | null => {
    if (!gs) return null;
    const i = order.indexOf(deviceId);
    return i >= 0 ? (gs.tanks[i] as unknown as TankShape) : null;
  };
  // Untrusted snapshots from peers are clamped: inventory counts to [0,99] (objects.ts
  // wraps item counts at 99) and cash to a sane non-negative bound (anti-OOM/crash).
  const clampInv = (inv: unknown): number[] => {
    const out = new Array<number>(NUM_ITEMS).fill(0);
    if (Array.isArray(inv)) {
      for (let i = 0; i < NUM_ITEMS; i++) {
        const v = inv[i];
        out[i] = typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(99, Math.trunc(v))) : 0;
      }
    }
    return out;
  };
  const clampCash = (c: unknown): number =>
    typeof c === "number" && Number.isFinite(c) ? Math.max(0, Math.min(1_000_000_000, Math.trunc(c))) : 0;

  return {
    startMatch(start: MatchStart): void {
      const cfg = Object.assign(new Config(), start.cfg) as Config;
      gs = createGameState(cfg, start.w, start.h, start.seed);
      order = [];
      for (const s of start.order) {
        gs.add_player(s.name, s.aiClass, 0, s.tankIcon);
        order.push(s.deviceId);
      }
      gs.new_game();
      void recordGameStart(); // this device started a (multiplayer) game
    },

    activeDeviceId(): string | null {
      if (!gs || !gs.current_shooter) return null;
      const idx = gs.tanks.indexOf(gs.current_shooter);
      return idx >= 0 ? (order[idx] ?? null) : null;
    },

    applyTurnInput(input: TurnInput): void {
      if (!gs) return;
      const t = gs.current_shooter;
      if (!t) return;
      const s = sanitizeTurnInput(input);
      t.angle = s.angle;
      t.power = s.power;
      t.selected_weapon = s.weapon;
      gs.fire(t);
    },

    worldHash(): string {
      return gs ? worldHash(gs) : "0";
    },

    snapshot(): unknown {
      diag.log.warning("lockstep: snapshot not yet implemented; desync is detected, not auto-healed");
      return null;
    },

    restore(_snap: unknown): void {
      diag.log.warning("lockstep: restore not yet implemented (see snapshot TODO)");
    },

    state(): GameState | null {
      return gs;
    },

    deviceIds(): string[] {
      return order.slice();
    },

    humanDeviceIds(): string[] {
      if (!gs) return [];
      const out: string[] = [];
      for (let i = 0; i < gs.tanks.length; i++) {
        if ((gs.tanks[i] as unknown as TankShape).ai_class === C.AI_HUMAN && order[i]) out.push(order[i]);
      }
      return out;
    },

    tankOf(deviceId: string): unknown {
      return tankAt(deviceId);
    },

    shopSnapshot(deviceId: string): ShopResult | null {
      const t = tankAt(deviceId);
      if (!t) return null;
      return { inv: t.inventory.slice(), cash: t.cash };
    },

    applyShopSnapshot(deviceId: string, snap: ShopResult): void {
      const t = tankAt(deviceId);
      if (!t) return;
      t.inventory = clampInv(snap.inv);
      t.cash = clampCash(snap.cash);
    },

    finishShop(): void {
      if (!gs) return;
      gs.run_ai_buys();
      gs.begin_next_round();
    },
  };
}
