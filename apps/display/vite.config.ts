import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// Three pages: the display, the spend screen at /spend, and the landing page at /landing.
const page = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [preact()],
  build: {
    sourcemap: true,
    target: "es2022",
    rollupOptions: { input: { index: page("index.html"), spend: page("spend/index.html"), landing: page("landing/index.html") } },
  },
  server: { proxy: { "/v1": "http://127.0.0.1:4100" } },
});
