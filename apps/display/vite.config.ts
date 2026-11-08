import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// Two pages: the display, and the spend screen at /spend.
const page = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [preact()],
  build: {
    sourcemap: true,
    target: "es2022",
    rollupOptions: { input: { index: page("index.html"), spend: page("spend/index.html") } },
  },
  server: { proxy: { "/v1": "http://127.0.0.1:4100" } },
});
