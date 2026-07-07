// ───────────────────────────────────────────────────────────────────────────
// CHAT OVERLAY — the transparent match chat, shared by the LOBBY and the
// IN-GAME screen (one instance travels from MultiplayerScreen into MpGameScreen,
// so the conversation survives the match start).
//
// Modal by design: while the compose box is open it captures EVERY key, because
// the game binds almost everything (Enter fires, letters are accelerators). The
// wire layer (net/lockstep sendChat/onChat) sanitizes and rate-limits; this class
// mirrors the sanitize on the local echo so what you see is what was sent. Pure
// overlay state — it never touches the simulation.
// ───────────────────────────────────────────────────────────────────────────
import * as pygame from "./pygame";
import * as W from "./widgets";
import { sanitizeChat } from "./net/lockstep";
import type { ScreenEvent } from "./screen";

const CHAT_KEEP = 50; // lines retained
const CHAT_SHOW = 6; // lines visible in the overlay
const CHAT_TTL_S = 20; // a line fades from the overlay after this long
const CHAT_INPUT_MAX = 100; // compose-box length cap (wire caps again at 120)

export class ChatOverlay {
  open = false;
  private lines: { name: string; text: string; at: number }[] = [];
  private text = "";
  private nowS = 0; // monotonic overlay clock (line fading)

  constructor(
    private readonly send: (text: string) => void,
    private readonly myName: () => string,
  ) {}

  tick(dt: number): void {
    this.nowS += dt;
  }

  /** Record a received (already sanitized) line. */
  push(name: string, text: string): void {
    this.lines.push({ name, text, at: this.nowS });
    if (this.lines.length > CHAT_KEEP) this.lines.splice(0, this.lines.length - CHAT_KEEP);
  }

  count(): number {
    return this.lines.length;
  }

  last(): string | null {
    return this.lines.length > 0 ? this.lines[this.lines.length - 1].text : null;
  }

  /** Modal compose-box keys (call only while `open`): Esc cancels, Enter sends,
   *  Backspace edits, printable characters append (event.unicode carries the
   *  produced character). */
  handleKey(event: ScreenEvent): void {
    if (event.key === pygame.K_ESCAPE) {
      this.open = false;
      this.text = "";
      return;
    }
    if (event.key === pygame.K_RETURN || event.key === pygame.K_KP_ENTER) {
      const clean = sanitizeChat(this.text); // mirror exactly what the wire will carry
      if (clean) {
        this.send(clean);
        this.push(this.myName(), clean); // broadcast excludes self: local echo
      }
      this.open = false;
      this.text = "";
      return;
    }
    if (event.key === pygame.K_BACKSPACE) {
      this.text = this.text.slice(0, -1);
      return;
    }
    const u = event.unicode ?? "";
    if (u.length === 1 && u.charCodeAt(0) >= 0x20 && this.text.length < CHAT_INPUT_MAX) {
      this.text += u;
    }
  }

  /** Transparent overlay: the last few lines (fading) bottom-left, plus the
   *  compose box while typing. Drawn over the lobby, gameplay, and the shop. */
  draw(surf: pygame.Surface, w: number, h: number): void {
    const f = W.font(14, false);
    const vis = this.lines.filter((l) => this.nowS - l.at < CHAT_TTL_S).slice(-CHAT_SHOW);
    const rows = vis.length + (this.open ? 1 : 0);
    if (rows === 0) return;
    const lh = f.get_height() + 4;
    const x = 12;
    const bw = 620;
    const y0 = h - 66 - rows * lh;
    // Semi-transparent backdrop so the text reads over terrain/panels alike.
    const ov = new pygame.Surface([bw, rows * lh + 10], pygame.SRCALPHA);
    ov.fill([0, 0, 0, 110]);
    surf.blit(ov, [x - 6, y0 - 5]);
    let y = y0;
    for (const l of vis) {
      const name = f.render(`${l.name}: `, true, [180, 220, 255]);
      surf.blit(name, [x, y]);
      surf.blit(f.render(l.text, true, [235, 235, 235]), [x + name.get_width(), y]);
      y += lh;
    }
    if (this.open) {
      surf.blit(f.render(`say: ${this.text}_`, true, [140, 230, 160]), [x, y]);
    }
  }
}
