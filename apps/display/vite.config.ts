import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [preact()],
  build: { sourcemap: true, target: "es2022" },
  server: { proxy: { "/v1": "http://127.0.0.1:4100" } },
});
