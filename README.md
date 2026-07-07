# Scorched Earth - Multiplayer (HTML5 / TypeScript fork)

A browser reimplementation of **Scorched Earth v1.5** (1995, DOS) by **Wendell Hicken** -
"The Mother of All Games" - running natively on TypeScript + Canvas2D + Web Audio,
**with online multiplayer added** (serverless peer-to-peer; see below).
No plugins, no WASM, no Python or DOS runtime.

This is the multiplayer fork of the single-player port. **Play it at
https://digitalcybersoft.github.io/scorchedearth-multi/** - open it in two or more
browsers (or devices, up to 10 tanks per match), create a private match in one, and
join with the invite code in the others; people can keep joining until the host
starts, computer opponents can fill the remaining slots, and there is a room chat
while you wait. Discovery and signaling run over public Nostr relays with no server
to set up. The single-player original is at
https://digitalcybersoft.github.io/scorchedearth-html5/ .

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

1. Main Menu -> **Online Play** -> choose your name and tank on the setup screen
   (color and starting position are randomized).
2. **Create Private Match** (share the invite code) or **Create Public Match** (others
   find it in the public list), or **Join by Code**. Joins stay open until the host
   starts, up to the engine's 10-tank round limit (humans outrank staged computers
   if the room fills).
3. The host can also **Add Computer** opponents in the lobby (class *Unknown*: the
   engine rolls a random personality at first reveal). A match can even be the host
   alone against computers.
4. When everyone shows connected, the host presses **Start**. Players take turns:
   adjust angle (left/right) and power (up/down), then **Space** to fire. Idling at
   your own turn past the countdown just **skips that turn** - your tank stays
   alive and in the round, and play passes to the next player. A slow or
   backgrounded browser is never treated as idle - the clock only runs once your
   own game reaches your turn, and an unfocused window fast-forwards its
   simulation to catch up in real time. Computer tanks taunt before firing and
   when destroyed, as in the original. A round that never resolves on its own is
   force-ended after 1,000 turns - the same deterministic bound on every client.
5. If a player disconnects mid-match, their tank retreats out of the current round
   (no kill bonus for anyone) and the host is asked whether to **replace them with
   a computer**; the match then carries on (otherwise it ends once you are the
   last one standing, as before).
6. **Between rounds the weapon shop opens for everyone at once.** Each player shops
   their own tank; purchases are replicated to every client. The next round starts
   when **every player has finished** (host-coordinated). There is no flat countdown:
   a player only times out after 60 seconds of shop **inactivity** (any input resets
   it), which then auto-submits whatever is in their cart. An absolute per-shop
   ceiling (5 minutes) stops a hostile client from stalling the match forever.
7. **Chat any time with the backquote key (`)** - in the lobby while waiting for the
   host to start, and in-game during aiming, flight, the shop, or the between-round
   wait (the lobby conversation stays on screen into the match). It is a transparent
   overlay: Esc cancels, Enter sends, lines fade after a few seconds. Chat rides its
   own message type and never touches the simulation.

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
- A 2-browser **shop-barrier + chat acceptance**: an untouched shop auto-finishes at the
  idle allowance (not before, not at the ceiling); a player **actively shopping far past
  the idle allowance is never cut off** and the round advances within a second of the
  last cart; chat lines typed with real keys replicate to the other browser during
  gameplay and over the open shop; inventories and world hashes converge, zero desyncs.
- A desync-detection + **solo-continuation** acceptance: a clean run reports zero
  desyncs; a deliberately injected divergence is caught by BOTH clients (everyone
  broadcasts and compares per-turn hashes, host included), after which each side
  detaches and keeps playing its own world with the other humans handed to the
  computer - chat still flows between the detached clients.
- A **turn-skip acceptance**: with a 4-second turn timer, an idle turn is skipped
  (both tanks stay alive on both clients), the skipped player gets their next turn
  back, and a real shot afterwards still converges with zero desyncs.
- A **throttled-client acceptance**: with the guest's CPU throttled 15x while the host
  fires, the round never ends early, the slow guest is never forfeited, and its world
  hash converges with the host's once it catches up.
- An **AI-opponent acceptance**: 2 humans + 1 lobby-added computer play a full round;
  AI turns auto-resolve identically on every client, hashes match at every aim barrier.
- A **CPU-replacement acceptance**: the guest closes mid-match; the host is prompted,
  approves, the departed tank converts to a computer at its next turn, and the match
  keeps progressing instead of aborting.
- A 3-browser **lobby acceptance**: three humans join one room, a chat line typed in
  the lobby replicates to both other browsers before the start, the conversation is
  still on screen once the match begins, and all three converge after the first turn.
- Behavioral checks for the turn-timeout skip, the disconnect retreat, and
  match-ends-on-disconnect.

Code: `src/net/{nostr,peer,signaling,match,lockstep,engine_adapter,sim_driver,metrics}.ts`,
the lobby `src/screens_mp.ts`, and the in-game screen `src/screens_mp_game.ts`.

Netcode safety: a turn input is applied only at each client's AIM barrier (a fast client
never applies the next turn while still animating the previous shot); round-end and the
turn-cap forfeit are recomputed deterministically on every client. The between-round shop
is host-authoritative: each player submits its own finalized cart, and the host broadcasts
one snapshot of every tank's inventory that every client applies before the next round, so
message ordering cannot desync inventories. The host advances the shop only when every
cart is in, when every missing player has been shop-inactive past the allowance, or at the
absolute ceiling; shop carts and keepalives are **round-tagged** so a message from one shop
can never satisfy another shop's barrier. Timeouts and evictions ride the same numbered
turn pipeline as shots, so they are ordered and applied at every client's own aim
barrier: a turn timeout is a **skip turn** (lose the turn, stay in the round), enforced
by the active player's OWN client (a slow or backgrounded browser is late, not idle);
the host may stand in only for a client that cannot self-enforce - a skip for a stuck
but still-connected one, a retreat/convert for a transport-dead one - never a shot.
Behavioral tests pin that a skip kills nobody and a retreat still removes the tank
(`test/mp_skip_solo.test.ts`). Each client
also steps its simulation by real elapsed time (bounded), so an unfocused window whose
rAF Chrome pauses fast-forwards to the barrier instead of crawling in slow motion. The
host's copy of the match config is sanitized before broadcast (team mode off, sequential
play), and every roster slot gets a distinct team id, so persisted single-player settings
cannot collapse the round flow. Untrusted peer input is bounds-checked (angle/power/
weapon clamped, NaN rejected, aiClass clamped, the turn buffer is windowed and
per-sender), chat is sanitized (control characters stripped, length-capped) and per-peer
rate-limited, and match-control messages (start / shop outcome) are accepted only from
the host's authenticated data channel.

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
- A detected desync is **not auto-healed** (`EngineAdapter.snapshot`/`restore` is a
  stub: it would wire `savegame.serialize`/`apply` plus the MT19937 stream position).
  Instead each client that detects one **degrades to solo play**: it detaches from
  the session (chat stays live) and continues its own world with the remote humans
  handed to the computer, rather than letting the split worlds cascade into stalls
  and a collapsed round. Re-joining a synced match means starting a new one.
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
| <img src="screenshots/mp-waiting.png" width="270"><br>The other player's turn | <img src="screenshots/mp-shop.png" width="270"><br>The between-round weapon shop | <img src="screenshots/mp-standings.png" width="270"><br>Between-round standings |

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

- **15,733 tests** (`npm test`, vitest): differential tests assert the TypeScript
  reproduces the Python port's output **exactly** (integers, pixels, bytes) or within
  a tight epsilon (transcendental math only), plus this fork's own multiplayer
  determinism suites. The RNG reproduces CPython's Mersenne Twister bit-for-bit; the
  game engine is checked by 29,814 turn/round state snapshots; the sprites by ~8M
  pixel assertions.
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
npm test             # the 15,732 tests (differential vs the Python oracle + MP determinism)
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
