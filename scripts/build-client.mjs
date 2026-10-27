// Bundles client scripts and copies self-hosted fonts into public/.
import { build } from "esbuild";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

await build({
  entryPoints: { map: "src/client/map.ts", enhance: "src/client/enhance.ts" },
  outdir: "public/js", bundle: true, minify: true, format: "iife", target: ["es2020"], sourcemap: false, logLevel: "warning",
});

const fonts = [
  ["@fontsource/source-serif-4/files", ["source-serif-4-latin-400-normal.woff2", "source-serif-4-latin-400-italic.woff2", "source-serif-4-latin-600-normal.woff2"]],
  ["@fontsource/ibm-plex-sans/files", ["ibm-plex-sans-latin-400-normal.woff2", "ibm-plex-sans-latin-500-normal.woff2", "ibm-plex-sans-latin-600-normal.woff2"]],
];
mkdirSync("public/fonts", { recursive: true });
for (const [dir, files] of fonts) {
  for (const f of files) {
    const src = join("node_modules", dir, f);
    if (!existsSync(src)) throw new Error(`Font not found: ${src}`);
    copyFileSync(src, join("public/fonts", f));
  }
}
console.log("client assets built");
