/**
 * Wrangler turns these imports into real module types at build time (see the
 * default `CompiledWasm` rule for .wasm and the [[rules]] entry for .ttf in
 * wrangler.toml). TypeScript needs to be told what they resolve to.
 */

declare module "*.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}

declare module "*.ttf" {
  const bytes: ArrayBuffer;
  export default bytes;
}
