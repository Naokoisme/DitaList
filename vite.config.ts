import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    sourcemap: process.env.DITALIST_SOURCE_MAPS === "1",
    rollupOptions: {
      input: {
        index: path.resolve(projectRoot, "index.html"),
        floating: path.resolve(projectRoot, "floating.html"),
      },
    },
  },
  server: { host: "127.0.0.1", port: 4318, strictPort: true },
});
