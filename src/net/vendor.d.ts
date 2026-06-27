// Ambient declaration for `qrcode` (ships no .d.ts and we deliberately avoid
// adding @types/qrcode so the fork installs offline). Only the surface we use.
declare module "qrcode" {
  export function toDataURL(text: string, opts?: unknown): Promise<string>;
  export function toCanvas(canvas: HTMLCanvasElement, text: string, opts?: unknown): Promise<void>;
  const _default: { toDataURL: typeof toDataURL; toCanvas: typeof toCanvas };
  export default _default;
}
