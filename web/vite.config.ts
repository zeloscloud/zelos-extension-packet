import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "src");

// One HTML document per panel: src/panels/<id>.html -> dist/panels/<id>.html.
function documents(): Record<string, string> {
  const inputs: Record<string, string> = {};
  const panels = resolve(src, "panels");
  for (const file of readdirSync(panels)) {
    if (file.endsWith(".html")) inputs[`panels/${file.slice(0, -".html".length)}`] = resolve(panels, file);
  }
  return inputs;
}

export default defineConfig({
  root: src,
  // Relative asset URLs, so documents load from zelos-app://<id>/~<version>/<entry>.
  base: "./",
  // Copied as-is into dist/: public/panels/<id>.options.json.
  publicDir: resolve(here, "public"),
  plugins: [react()],
  build: {
    // The repository root's dist/, which the manifest's panel entry and [package] paths name.
    outDir: resolve(here, "../dist"),
    emptyOutDir: true,
    // AG Grid is most of the bundle. One document per panel, read from the installed package, not a network.
    chunkSizeWarningLimit: 2048,
    rollupOptions: { input: documents() },
  },
  test: {
    root: here,
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
  },
});
