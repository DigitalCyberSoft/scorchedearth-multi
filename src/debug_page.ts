/**
 * debug_page.ts -- the /debug.html device profiler (a second vite entry).
 *
 * Answers "why is the game slow on THIS machine" without remote access:
 *   1. device facts (UA, cores, memory, GPU string, timer granularity),
 *   2. canvas primitive benches sized to the game's real pattern (1024x768
 *      willReadFrequently surfaces, the present blit, per-render text canvases,
 *      1x1-fillRect pixel stamping, GPU readback),
 *   3. a live sample of the real game (same-origin iframe): rAF frame times on
 *      the shared main thread, longtasks, and per-canvas-API call counts taken
 *      by patching the iframe realm's CanvasRenderingContext2D prototype,
 *   4. a plain-text report (copy/paste), and
 *   5. BEAM: publish the report over the game's own Nostr relays
 *      (publishReplaceable on the shared app channel, d-tag "debug:<code>") so
 *      the report can be RECEIVEd on another machine with the 5-char code.
 *      countPlayers24h filters d-tags to "start:*", so debug tags cannot
 *      pollute the player metric on the same channel.
 *
 * The frame-time dilation figure mirrors src/main.ts:980 exactly:
 * dt = min(elapsed, 1/30) -- below 30 fps the game runs in slow motion by
 * design of the dt clamp, and this page measures by how much.
 */
import { publishReplaceable, queryReplaceable } from "./net/nostr";
import { STAT_KIND, PUBLIC_LOBBY_KEY, setRelayOverride, activeRelays } from "./net/netconfig";

const REPORT_VERSION = "v2";
const SAMPLE_MS = 10_000;
const BEAM_TAG_PREFIX = "debug:";
const MAX_REPORT_BYTES = 32_768;
const RECV_POLL_MS = 5_000;
const RECV_POLL_MAX = 120; // 10 min

// ---------------------------------------------------------------------------
// report state -- each section writes its block; render() rebuilds the
// textarea so a partial run still yields a usable paste.
// ---------------------------------------------------------------------------
const R = { device: "", bench: "", sample: "" };

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error("debug page element missing: " + id);
  return el;
}
const report = (): HTMLTextAreaElement => $("dbg-report") as HTMLTextAreaElement;

function buildReport(): string {
  const parts = [`== scorched-earth device profile ${REPORT_VERSION} ==`, "when: " + new Date().toISOString()];
  if (R.device) parts.push("", "-- device --", R.device);
  if (R.bench) parts.push("", "-- canvas benches --", R.bench);
  if (R.sample) parts.push("", "-- live game sample --", R.sample);
  return parts.join("\n");
}
function render(): void {
  report().value = buildReport();
  const ready = R.bench !== "" || R.sample !== "";
  ($("dbg-copy-btn") as HTMLButtonElement).disabled = !ready;
  ($("dbg-beam-btn") as HTMLButtonElement).disabled = !ready;
}

// ---------------------------------------------------------------------------
// 1. device -- every probe individually guarded: this is a reporting boundary;
// a missing API is recorded as its error string, not hidden.
// ---------------------------------------------------------------------------
function probe(fn: () => unknown): string {
  try {
    const v = fn();
    return v === undefined || v === null ? "n/a" : String(v);
  } catch (e) {
    return "unavailable: " + String(e);
  }
}

function gpuString(): string {
  const cv = document.createElement("canvas");
  const gl = (cv.getContext("webgl") ?? cv.getContext("experimental-webgl")) as WebGLRenderingContext | null;
  if (!gl) return "no webgl context";
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  if (!ext) return String(gl.getParameter(gl.RENDERER));
  return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
}

/** Distinct performance.now() values in a tight loop expose clamped timers
 *  (privacy modes clamp to 0.1 ms or coarser; that degrades the per-call ms
 *  attribution below while the call COUNTS stay exact). */
function timerGranularity(): string {
  const seen = new Set<number>();
  const t0 = performance.now();
  while (performance.now() - t0 < 20) seen.add(performance.now());
  const span = performance.now() - t0;
  return `${(span / Math.max(1, seen.size - 1)).toFixed(4)} ms/step (${seen.size} distinct in ${span.toFixed(1)} ms)`;
}

function collectDevice(): string {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return [
    "ua: " + probe(() => navigator.userAgent),
    "cores: " + probe(() => navigator.hardwareConcurrency),
    "deviceMemory(GiB): " + probe(() => nav.deviceMemory),
    "dpr: " + probe(() => devicePixelRatio),
    "screen: " + probe(() => `${screen.width}x${screen.height}`),
    "visibility: " + probe(() => document.visibilityState),
    "gpu: " + probe(gpuString),
    "timer: " + probe(timerGranularity),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 2. canvas benches -- adaptive: run each op until ~250 ms elapsed, report
// ms/op. GPU-canvas ops are submission-timed; a 1x1 getImageData at the end
// forces completion into the measured window (noted in the output).
// ---------------------------------------------------------------------------
function makeCanvas(hint: boolean): { cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const cv = document.createElement("canvas");
  cv.width = 1024;
  cv.height = 768;
  const ctx = cv.getContext("2d", hint ? { willReadFrequently: true } : undefined);
  if (ctx === null) throw new Error("2d context unavailable");
  return { cv, ctx };
}

function benchLoop(op: (i: number) => void, flush?: () => void): string {
  const t0 = performance.now();
  let n = 0;
  while (performance.now() - t0 < 250) {
    op(n);
    n++;
  }
  if (flush) flush();
  const ms = performance.now() - t0;
  return `${(ms / n).toFixed(3)} ms/op  (${n} ops)`;
}

function runBenches(): string {
  const sw = makeCanvas(true);
  const gpu = makeCanvas(false);
  const page = makeCanvas(false);
  const lines: string[] = [];
  lines.push(
    "swFill   (fill 1024x768, willReadFrequently): " +
      benchLoop((i) => {
        sw.ctx.fillStyle = i & 1 ? "#123" : "#321";
        sw.ctx.fillRect(0, 0, 1024, 768);
      }),
  );
  lines.push(
    "gpuFill  (fill 1024x768, default canvas):      " +
      benchLoop(
        (i) => {
          gpu.ctx.fillStyle = i & 1 ? "#123" : "#321";
          gpu.ctx.fillRect(0, 0, 1024, 768);
        },
        () => gpu.ctx.getImageData(0, 0, 1, 1),
      ),
  );
  lines.push(
    "present  (drawImage sw->page 1024x768):        " +
      benchLoop(
        () => page.ctx.drawImage(sw.cv, 0, 0),
        () => page.ctx.getImageData(0, 0, 1, 1),
      ),
  );
  lines.push(
    "text     (new canvas + fillText, per render):  " +
      benchLoop((i) => {
        const cv = document.createElement("canvas");
        cv.width = 256;
        cv.height = 32;
        const c = cv.getContext("2d", { willReadFrequently: true });
        if (c === null) return;
        c.font = "bold 20px sans-serif";
        c.fillStyle = "#fff";
        c.fillText("Scorched Earth " + (i & 7), 0, 24);
      }),
  );
  lines.push(
    "setat    (10k 1x1 fillRect, willReadFrequently): " +
      benchLoop(() => {
        for (let k = 0; k < 10_000; k++) {
          sw.ctx.fillStyle = "#4a4";
          sw.ctx.fillRect(k & 1023, (k * 7) & 767, 1, 1);
        }
      }) +
      "  [per 10k px]",
  );
  lines.push("readback (getImageData 1x1 from default canvas): " + benchLoop(() => gpu.ctx.getImageData(0, 0, 1, 1)));
  lines.push("note: gpu-canvas timings are submission+flush, not per-op completion.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 3. live game sample -- same-origin iframe; sampling patches the iframe
// realm's canvas prototype methods with count+time wrappers for the window,
// samples rAF deltas on this (shared) main thread, and watches longtasks.
// ---------------------------------------------------------------------------
const PATCHED = ["fillRect", "drawImage", "fillText", "clearRect", "getImageData", "putImageData", "measureText"] as const;

interface CallStat {
  n: number;
  ms: number;
}
type Stats = Record<string, CallStat>;

function patchCanvas(win: Window & typeof globalThis, stats: Stats): () => void {
  const proto = win.CanvasRenderingContext2D.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const saved: Record<string, (...a: unknown[]) => unknown> = {};
  for (const name of PATCHED) {
    const orig = proto[name];
    saved[name] = orig;
    const s: CallStat = { n: 0, ms: 0 };
    stats[name] = s;
    proto[name] = function (this: unknown, ...a: unknown[]): unknown {
      const t0 = performance.now();
      const r = orig.apply(this, a);
      s.ms += performance.now() - t0;
      s.n++;
      return r;
    };
  }
  // canvas creation churn (one per Font.render / Surface in the port)
  const docProto = win.Document.prototype as unknown as { createElement: (...a: unknown[]) => unknown };
  const origCreate = docProto.createElement;
  const created: CallStat = { n: 0, ms: 0 };
  stats.createCanvas = created;
  docProto.createElement = function (this: unknown, ...a: unknown[]): unknown {
    if (String(a[0]).toLowerCase() === "canvas") created.n++;
    return origCreate.apply(this, a);
  };
  return () => {
    for (const name of PATCHED) proto[name] = saved[name];
    docProto.createElement = origCreate;
  };
}

function sampleGame(win: Window & typeof globalThis, live: HTMLElement, done: () => void): void {
  const stats: Stats = {};
  const unpatch = patchCanvas(win, stats);
  const deltas: number[] = [];
  const longtasks = { n: 0, ms: 0, err: "" };
  let obs: PerformanceObserver | null = null;
  try {
    obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longtasks.n++;
        longtasks.ms += e.duration;
      }
    });
    obs.observe({ entryTypes: ["longtask"] });
  } catch (e) {
    longtasks.err = String(e); // reported, not hidden (older engines lack longtask)
  }

  const t0 = performance.now();
  let last: number | null = null;
  const tick = (now: number): void => {
    if (last !== null) deltas.push(now - last);
    last = now;
    const left = SAMPLE_MS - (now - t0);
    if (left > 0) {
      if ((deltas.length & 15) === 0) live.textContent = "sampling... " + Math.ceil(left / 1000) + " s";
      requestAnimationFrame(tick);
      return;
    }
    unpatch();
    if (obs) obs.disconnect();
    R.sample = summarize(deltas, stats, longtasks);
    live.textContent = "sample done; report below.";
    done();
    render();
  };
  requestAnimationFrame(tick);
}

function summarize(deltas: number[], stats: Stats, longtasks: { n: number; ms: number; err: string }): string {
  const s = [...deltas].sort((a, b) => a - b);
  const sum = deltas.reduce((a, b) => a + b, 0);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const CAP = 1000 / 30; // src/main.ts:980
  const applied = deltas.reduce((a, d) => a + Math.min(d, CAP), 0);
  const frames = deltas.length;
  const lines = [
    `frames: ${frames} over ${(sum / 1000).toFixed(1)} s`,
    "fps: " + (1000 / (sum / frames)).toFixed(1),
    `frame ms: median ${q(0.5).toFixed(1)}  p95 ${q(0.95).toFixed(1)}  max ${q(1).toFixed(1)}`,
    "game-time dilation (1.0 = real time): " + (applied / sum).toFixed(2),
    "longtasks: " + (longtasks.err !== "" ? longtasks.err : `${longtasks.n} (${longtasks.ms.toFixed(0)} ms total)`),
    "",
    "canvas calls during sample (calls, total ms, calls/frame):",
  ];
  const keys = Object.keys(stats).sort((a, b) => stats[b].ms - stats[a].ms);
  for (const k of keys) {
    const v = stats[k];
    lines.push(
      "  " +
        k.padEnd(12) +
        String(v.n).padStart(9) +
        "  " +
        v.ms.toFixed(0).padStart(7) +
        " ms  " +
        (v.n / Math.max(1, frames)).toFixed(1).padStart(8) +
        "/frame",
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 5. beam / receive over the game's relays.  Shared-channel-key events, like
// all lobby traffic: anyone with the app can publish, so a received report is
// diagnostic input, not authenticated truth.  Content is length-capped and
// only ever rendered as textarea VALUE (no markup interpretation).
// ---------------------------------------------------------------------------
interface BeamPayload {
  report?: string;
  ts?: number;
  v?: number;
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
function newCode(): string {
  const buf = new Uint32Array(5);
  crypto.getRandomValues(buf);
  let out = "";
  for (const v of buf) out += CODE_ALPHABET[v % CODE_ALPHABET.length];
  return out;
}

async function beam(code: string, text: string, net: HTMLElement): Promise<void> {
  net.textContent = `beaming to ${activeRelays().length} relay(s)...`;
  await publishReplaceable(STAT_KIND, PUBLIC_LOBBY_KEY, BEAM_TAG_PREFIX + code, {
    report: text.slice(0, MAX_REPORT_BYTES),
    ts: Date.now(),
    v: 1,
  } satisfies BeamPayload);
  // read-your-write: publishReplaceable settles per relay without failing, so
  // confirm the event is actually queryable before claiming success.
  const got = await fetchBeam(code);
  if (got === null) {
    net.textContent = "beam NOT confirmed: published but not readable back; relays may have rejected it. Copy/paste the report instead.";
    return;
  }
  net.textContent = `beamed and confirmed. On the other machine: open debug.html and Receive with code ${code}.`;
}

async function fetchBeam(code: string): Promise<string | null> {
  const recs = await queryReplaceable<BeamPayload>(STAT_KIND, PUBLIC_LOBBY_KEY);
  const hits = recs
    .filter((r) => r.dTag === BEAM_TAG_PREFIX + code && typeof r.data?.report === "string")
    .sort((a, b) => b.createdAt - a.createdAt);
  if (hits.length === 0) return null;
  return (hits[0].data.report as string).slice(0, MAX_REPORT_BYTES);
}

function receive(code: string, net: HTMLElement): void {
  let polls = 0;
  const poll = async (): Promise<void> => {
    polls++;
    net.textContent = `waiting for ${code}... (poll ${polls}/${RECV_POLL_MAX})`;
    let text: string | null = null;
    try {
      text = await fetchBeam(code);
    } catch (e) {
      net.textContent = `relay query failed: ${String(e)}`;
    }
    if (text !== null) {
      report().value = text;
      net.textContent = `received ${code} (${text.length} bytes).`;
      // for a headless attach: the report is also on the console
      console.log("[debug-receive]", code, "\n" + text);
      return;
    }
    if (polls < RECV_POLL_MAX) setTimeout(() => void poll(), RECV_POLL_MS);
    else net.textContent = `gave up waiting for ${code} after 10 min.`;
  };
  void poll();
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
function init(): void {
  const params = new URLSearchParams(location.search);
  const relaysParam = params.get("relays");
  if (relaysParam) setRelayOverride(relaysParam.split(","));

  const live = $("dbg-live");
  const net = $("dbg-net");
  const code = newCode();
  $("dbg-code").textContent = code;

  R.device = collectDevice();
  $("dbg-device").textContent = R.device;
  render();

  $("dbg-bench-btn").addEventListener("click", () => {
    ($("dbg-bench-btn") as HTMLButtonElement).disabled = true;
    $("dbg-bench").textContent = "running (~2 s)...";
    // let the label paint before the busy loops start
    setTimeout(() => {
      R.bench = runBenches();
      $("dbg-bench").textContent = R.bench;
      ($("dbg-bench-btn") as HTMLButtonElement).disabled = false;
      render();
    }, 50);
  });

  $("dbg-load-btn").addEventListener("click", () => {
    ($("dbg-load-btn") as HTMLButtonElement).disabled = true;
    $("dbg-frame-wrap").style.display = "block";
    const f = $("dbg-frame") as HTMLIFrameElement;
    f.addEventListener("load", () => {
      ($("dbg-sample-btn") as HTMLButtonElement).disabled = false;
      live.textContent = "game loaded; go to the laggy screen, then Sample.";
    });
    // carry the query through so ?relays= / ?test= reach the sampled game too
    f.src = "./index.html" + location.search;
  });

  $("dbg-sample-btn").addEventListener("click", () => {
    const f = $("dbg-frame") as HTMLIFrameElement;
    const win = f.contentWindow as (Window & typeof globalThis) | null;
    if (!win || !win.CanvasRenderingContext2D) {
      live.textContent = "iframe not ready";
      return;
    }
    ($("dbg-sample-btn") as HTMLButtonElement).disabled = true;
    sampleGame(win, live, () => {
      ($("dbg-sample-btn") as HTMLButtonElement).disabled = false;
    });
  });

  $("dbg-copy-btn").addEventListener("click", () => {
    const ta = report();
    navigator.clipboard.writeText(ta.value).then(
      () => {
        live.textContent = "copied.";
      },
      (e) => {
        // clipboard needs a secure context + permission; select for manual copy
        ta.focus();
        ta.select();
        live.textContent = `clipboard blocked (${String(e)}); text selected, press Ctrl+C.`;
      },
    );
  });

  $("dbg-beam-btn").addEventListener("click", () => {
    ($("dbg-beam-btn") as HTMLButtonElement).disabled = true;
    beam(code, report().value, net) // beam exactly what the textarea shows
      .catch((e) => {
        net.textContent = `beam failed: ${String(e)}`;
      })
      .finally(() => {
        ($("dbg-beam-btn") as HTMLButtonElement).disabled = false;
      });
  });

  $("dbg-recv-btn").addEventListener("click", () => {
    const c = ($("dbg-recv-code") as HTMLInputElement).value.trim().toUpperCase();
    if (c.length !== 5) {
      net.textContent = "enter the 5-char code shown on the beaming machine.";
      return;
    }
    receive(c, net);
  });

  // ?attach=CODE auto-starts receiving (headless-friendly)
  const attach = params.get("attach");
  if (attach !== null && attach.trim() !== "") {
    const c = attach.trim().toUpperCase();
    ($("dbg-recv-code") as HTMLInputElement).value = c;
    receive(c, net);
  }
}

// DOM gate: vitest/node imports of this module (coverage instrumentation) must
// neither wire listeners nor touch a document that is not the debug page.
if (typeof document !== "undefined" && document.getElementById("dbg-report") !== null) {
  init();
}
