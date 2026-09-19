import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// The popup is the only part of the extension that gets built. Output lands in
// `extension/popup/` and is committed, so "load unpacked" works from a fresh
// clone with no build step. `base: "./"` keeps asset URLs relative, which is
// what a chrome-extension:// page needs, and nothing is inlined because MV3's
// CSP forbids inline script.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: {
    outDir: path.resolve(import.meta.dirname, "../extension/popup"),
    emptyOutDir: true,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
