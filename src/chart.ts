/**
 * Rasterisation of the all-time distribution image (design section 6.2).
 *
 * Self-contained: the SVG comes from `chart-svg.ts` and is rasterised here in
 * the Worker with @resvg/resvg-wasm. Nothing leaves the account — the
 * alternative the design document offers, a QuickChart URL, would send
 * objective names and point counts to a third party.
 */

import { Resvg, initWasm } from "@resvg/resvg-wasm";
// Wrangler compiles these to a WebAssembly.Module and a byte array at build
// time (see the [[rules]] entry in wrangler.toml for the font).
import resvgWasm from "../node_modules/@resvg/resvg-wasm/index_bg.wasm";
import fontData from "../vendor/DejaVuSans-subset.ttf";
import { buildSvg } from "./chart-svg.js";
import type { Snapshot } from "./scoring.js";
import type { PhotoPayload } from "./telegram.js";

let wasmReady: Promise<void> | null = null;

/** `initWasm` may be called only once per isolate. */
function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = initWasm(resvgWasm as WebAssembly.Module).catch((err: unknown) => {
      // Allow a later call to retry rather than caching the failure forever.
      wasmReady = null;
      throw err;
    });
  }
  return wasmReady;
}

/**
 * The single entry point the call site uses. Returns null when the image cannot
 * be produced, so /stats degrades to its text view instead of failing.
 */
export async function renderDistribution(s: Snapshot): Promise<PhotoPayload | null> {
  try {
    await ensureWasm();
    const { svg, rows } = buildSvg(s);
    if (rows === 0) return null;

    const resvg = new Resvg(svg, {
      font: {
        fontBuffers: [new Uint8Array(fontData as ArrayBuffer)],
        defaultFontFamily: "DejaVu Sans",
        loadSystemFonts: false,
      },
      // 2x for a crisp image on a phone screen.
      fitTo: { mode: "zoom", value: 2 },
    });
    const png = resvg.render().asPng();
    return { png, filename: "all-time.png" };
  } catch (err) {
    console.error("chart render failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}
