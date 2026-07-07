# Scorched Earth - Multiplayer (HTML5 / TypeScript fork)

A browser reimplementation of **Scorched Earth v1.5** (1995, DOS) by **Wendell Hicken** -
"The Mother of All Games" - running natively on TypeScript + Canvas2D + Web Audio,
**with online multiplayer added** (serverless peer-to-peer; see below).
No plugins, no WASM, no Python or DOS runtime.

This is the multiplayer fork of the single-player port. **Play it at
https://digitalcybersoft.github.io/scorchedearth-multi/** - open it in two browsers (or
two devices), create a private match in one, and join with the invite code in the other;
discovery and signaling run over public Nostr relays with no server to set up. The
single-player original is at https://digitalcybersoft.github.io/scorchedearth-html5/ .

It reproduces the original's turn-based tank artillery - destructible terrain, the
weapon shop, the computer players, the physics and wind, the economy and scoring -
reconstructed function-for-function and verified against the original's behavior.

## Multiplayer (this fork)

`scorchedearth-multi` adds online play to the single-player engine. It is **serverless
and peer-to-peer**: there is no game server. Browsers connect over **WebRTC data
channels**, and the connection handshake (SDP offer/answer + ICE) is relayed through
public **Nostr relays**. A "room" is a shared 32-byte key that both encrypts the
signaling traffic and derives the room's Nostr identity, so only people with the key
can see or join a match.

- **Private match** - a freshly generated room key, shared out-of-band as an invite
  code (link/QR).
- **Public match** - announced on a well-known lobby channel so anyone can browse and
  join from the in-game list.
- **24h player count** - each game start publishes a hashed, dated marker to a shared
  channel; the count is a best-effort relay query (see "Limits").

Netcode is **host-authoritative lockstep**: the host fixes the seed, config, and turn
order; each turn only the active player's input is broadcast; every client re-runs the
same deterministic engine (seeded MT19937 + fixed physics step) and converges. After
each turn clients exchange a world hash so divergence is caught.

### How to play

1. Main Menu -> **Multiplayer** -> choose your name and tank on the setup screen
   (color and starting position are randomized).
2. **Create Private Match** (share the invite code) or **Create Public Match** (others
   find it in the public list), or **Join by Code**.
3. When everyone shows connected, the host presses **Start**. Players take turns:
   adjust angle (left/right) and power (up/down), then **Space** to fire. A countdown
   bounds each turn, and the match runs a set number of rounds.
4. **Between rounds a 60-second weapon shop opens.** Each player shops their own tank;
   purchases are replicated to every client. If everyone finishes early the next round
   starts immediately; anyone still idle when the timer runs out gets nothing.

### What works (verified)

A full match plays end to end: three separate browsers connect, play **5 rounds with
real keyboard input**, **shop for weapons between rounds**, and stay byte-for-byte
converged (identical world hash, zero desyncs). Verified by:

- `test/mp_lockstep.test.ts` - in-process determinism (5-round, up to 3 players, human
  and AI), part of `npm test`.
- A 2-browser connection over the **default public Nostr relays** (no local server): the
  peers discover each other from the invite and form the WebRTC mesh in seconds, then start
  a converged match. (The local relay below is only a faster, offline test fixture - public
  relays are the default and work.)
- A 3-browser, real-keypress, 5-round playthrough (run over a local relay for speed and
  determinism).
- A 3-browser **shop test**: two players buy weapons and one buys nothing; every client
  converges on identical inventories (an inventory digest, since the world hash omits
  inventory) plus identical world hash, zero desyncs.
- A desync-detection test: a clean run reports zero desyncs, and a deliberately injected
  divergence on one client is caught by the host.
- Behavioral checks for the per-turn forfeit and match-ends-on-disconnect.

Code: `src/net/{nostr,peer,signaling,match,lockstep,engine_adapter,sim_driver,metrics}.ts`,
the lobby `src/screens_mp.ts`, and the in-game screen `src/screens_mp_game.ts`.

Netcode safety: a turn input is applied only at each client's AIM barrier (a fast client
never applies the next turn while still animating the previous shot); round-end and the
turn-cap forfeit are recomputed deterministically on every client. The between-round shop
is host-authoritative: each player submits its own finalized cart, and the host broadcasts
one snapshot of every tank's inventory that every client applies before the next round, so
message ordering cannot desync inventories. Untrusted peer input is bounds-checked
(angle/power/weapon clamped, NaN rejected, the turn buffer is windowed and per-sender), and
match-control messages (start / forfeit / shop outcome) are accepted only from the host's
authenticated data channel.

### Not production-ready (honest limitations)

This is a working vertical slice, not a shipped product:

- **Symmetric-NAT pairs need a TURN relay, which is opt-in.** Signaling over the default
  public Nostr relays is proven, and multiple public **STUN** servers connect every NAT
  pair *except* two **symmetric** NATs - those physically require a TURN relay. TURN is
  wired and proven (the tests connect two peers **relay-only** through a TURN server and
  pass a message), but it **ships with no credentials**: there is no longer a reliable
  zero-signup public TURN (the Open Relay static-credential service is deprecated, verified
  here). To make it bulletproof across arbitrary networks, add free-tier TURN creds
  (**Metered** ~50 GB/mo or **Cloudflare** ~1 TB/mo, both free) to `TURN_SERVERS` in
  `src/net/netconfig.ts` and rebuild, or inject them at runtime with
  `?turn=<base64 of a JSON RTCIceServer>`. WebRTC connection testing so far was same-machine
  (loopback). (`?relays=ws://...` can still point at a private Nostr relay.)
- A detected desync is **reported, not auto-healed** (`EngineAdapter.snapshot`/`restore`
  is a stub: it would wire `savegame.serialize`/`apply` plus the MT19937 stream position).
  In practice the lockstep + host-authoritative shop have shown zero desyncs across the
  5-round and shop tests, but there is no recovery path if one ever occurs.
- The shop is **not server-refereed**: each client asserts its own resulting cart, so a
  modified client could grant itself items. Inventory values are bounds-clamped (anti-crash)
  but not validated against the economy. This is inherent to trustless P2P without a referee
  and matches the public-lobby trust posture below.
- The public-lobby key is a shipped constant, so the public list and the 24h start count
  are **best-effort and spoofable** - anyone running the app can write to those channels,
  and accuracy depends on relay retention. Treat the count as a rough signal, not analytics.
- Test hooks (the `__mp*` window globals, including an auto-fire driver) are compiled out
  of production and enabled only with `?test=1`.

## Screenshots

Captured from this TypeScript / Canvas port running in the browser.

### Online multiplayer (this fork)

Two browsers connected over the default public Nostr relays (lobby) and the in-match
overlay, shop, and standings. Both clients run the same deterministic engine in lockstep.

|   |   |   |
|:---:|:---:|:---:|
| <img src="screenshots/mp-lobby.png" width="270"><br>Create a match (invite code) | <img src="screenshots/mp-lobby-ready.png" width="270"><br>Lobby: both players connected | <img src="screenshots/mp-turn.png" width="270"><br>Your turn |
| <img src="screenshots/mp-waiting.png" width="270"><br>The other player's turn | <img src="screenshots/mp-shop.png" width="270"><br>The 60-second weapon shop | <img src="screenshots/mp-standings.png" width="270"><br>Between-round standings |

### Single-player

|   |   |   |
|:---:|:---:|:---:|
| <img src="screenshots/menu.png" width="270"><br>Title screen | <img src="screenshots/tank-setup.png" width="270"><br>Player and tank setup | <img src="screenshots/battlefield.png" width="270"><br>A turn in progress |
| <img src="screenshots/explosion.png" width="270"><br>A shell detonates | <img src="screenshots/death.png" width="270"><br>A direct hit | <img src="screenshots/shop.png" width="270"><br>The weapon shop |
| <img src="screenshots/control-panel.png" width="270"><br>In-game control panel | <img src="screenshots/rankings.png" width="270"><br>Round rankings | <img src="screenshots/game-over.png" width="270"><br>Final scoring |

## Credit: Wendell Hicken

Scorched Earth, subtitled "The Mother of All Games," was created by **Wendell Hicken**
and distributed as shareware for DOS. The original is Copyright (c) 1991-1995 Wendell
Hicken. All rights to Scorched Earth - its name, design, artwork, sound, terrain data,
and original code - belong to him. His site is `whicken.com`.

This project is an independent, **non-commercial tribute**. It is **not affiliated
with, endorsed by, or supported by Wendell Hicken**. The game design is entirely his;
this port only re-expresses its mechanics in TypeScript so the game can run in a
browser today. If you want the genuine article, seek out Wendell Hicken's original.

## How it was built, and how faithful it is

This is not a fresh interpretation - it is a *verified reimplementation*:

1. The original DOS binary was reverse-engineered **statically** (it is never executed)
   into a function-for-function **Python/pygame port**
   ([scorchedearth-python](https://github.com/DigitalCyberSoft/scorchedearth-python)),
   itself differential-tested against the recovered machine code.
2. This HTML5 build is a TypeScript rewrite of that Python port, with the Python port
   as the **oracle**: every module is proven to reproduce its Python counterpart.

The verification:

- **15,064 differential tests** (`npm test`, vitest) assert the TypeScript reproduces
  the Python port's output **exactly** (integers, pixels, bytes) or within a tight
  epsilon (transcendental math only). The RNG reproduces CPython's Mersenne Twister
  bit-for-bit; the game engine is checked by 25,814 turn/round state snapshots; the
  sprites by ~8M pixel assertions.
- A **visual regression gate** (`visual/`, `bash visual/run_gate.sh`) renders identical
  seeded game states through both the TypeScript Canvas renderer and the Python pygame
  renderer and pixel-diffs them. The game **world** - sky, terrain, tanks - comes out
  **byte-identical** (zero channel delta). Only on-screen text differs, because a
  browser's font rasterizer is not pygame's; that is expected and reported separately.

The original binary is never run by anything in this repository.

## Play

Open **https://digitalcybersoft.github.io/scorchedearth-html5/** in any modern browser.
There is nothing to install - it is a static HTML5 page (Canvas2D + Web Audio +
JavaScript). A short loading bar fetches the assets, then the menu appears.

Controls: Left/Right aim the turret, Up/Down adjust power, Tab cycles weapons,
Space or Enter fires, number keys select a tank, F11 toggles fullscreen, Esc backs
out. The menus, the weapon shop, and the in-game control panel (battery, parachute,
shield) are mouse-driven.

## Building from source (developers only)

The game is written in TypeScript and compiled **once** to the browser JavaScript that
ships above; players never run any of this. It is only for modifying the code.

```bash
npm install
npm run dev          # dev server at http://localhost:5173
npm run build        # static bundle into dist/ (what GitHub Pages serves)
npm test             # the 15,064 differential tests against the Python oracle
```

## The original assets

This repository **includes** Wendell Hicken's original v1.5 data files under
`public/assets/` - the 10 `.MTN` digitized mountains, `TALK1.CFG` / `TALK2.CFG` tank
taunts, and `SCORCH.ICO` - so the game plays with the genuine landscapes and taunts out
of the box. **These files are Wendell Hicken's property**, included only to keep this
tribute faithful and immediately playable; they are not the authors' to license. The
engine also runs without them (procedural terrain, gradient title, no taunts).

## How the code is organized

| Module | Reverses |
|--------|----------|
| `rng.ts` | CPython Mersenne Twister, bit-exact (the determinism linchpin) |
| `constants.ts` | byte-verified physics / damage / scoring / color-band constants |
| `terrain.ts` | the pixel framebuffer, terrain generation, carve / deposit / settle |
| `physics.ts` | the projectile integrator (gravity, wind, viscosity, speed clamp) |
| `weapons.ts`, `weapon_behaviors.ts` | the 48-item table; rollers, diggers, MIRV, laser, riot |
| `damage.ts`, `death.ts`, `hazard.ts` | radial damage, shields, fall damage, death throes, sky hazards |
| `ai.ts`, `guidance.ts` | the seven computer types and the aiming oracle |
| `economy.ts`, `scoring.ts` | the free-market shop, interest, scoring and rankings |
| `game.ts` | the round / turn loop, fire / impact pipeline, win test |
| `pygame.ts` | a faithful pygame API over Canvas2D (Surface, draw, surfarray, font) |
| `render.ts`, `ui.ts`, `widgets.ts`, `screens.ts`, `ingame.ts` | rendering, HUD, menus, shop, dialogs |
| `sprites.ts`, `palette.ts`, `sound.ts` | the recovered art + `.MTN` decoder, color tables, Web Audio |
| `mtn.ts` | the `.MTN` terrain-photo decoder |
| `main.ts` | the requestAnimationFrame loop, input, state machine, asset boot, IndexedDB saves |

`oracle/` holds the Python vector dumpers; `test/` the differential suite; `visual/`
the rendering gate.

## License and use

The TypeScript, HTML, and CSS authored in this repository are the authors' own work
and grant no rights to Scorched Earth itself. Game mechanics and rules, as distinct
from a specific implementation, are generally understood not to be protected by
copyright in the US; this port reimplements only the mechanics. Scorched Earth, its
name, and all of its assets remain the property of Wendell Hicken. Please treat this
as a personal, non-commercial tribute for play and study.
