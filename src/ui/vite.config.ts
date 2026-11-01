import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

const UI_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(UI_DIR, "../..");

const API_TARGET = process.env.API_TARGET ?? "http://127.0.0.1:4890";
const FRONTEND_PORT = Number.parseInt(process.env.FRONTEND_PORT ?? "4891", 10);

/** Proxies an API path, answering 503 `{ live: false }` while the API is down. */
const apiProxy: ProxyOptions = {
  target: API_TARGET,
  configure(proxy) {
    proxy.on("error", (_error, _request, response) => {
      if (response && "writeHead" in response) {
        if (!response.headersSent) {
          response.writeHead(503, {
            "content-type": "application/json; charset=utf-8",
          });
          response.end(`${JSON.stringify({ live: false })}\n`);
        } else {
          response.destroy();
        }
      } else {
        response?.destroy?.();
      }
    });
  },
};

export default defineConfig({
  root: UI_DIR,
  appType: "spa",
  plugins: [react()],
  css: {
    postcss: { plugins: [tailwindcss()] },
  },
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
    port: FRONTEND_PORT,
    strictPort: true,
    fs: {
      allow: [REPO_ROOT],
    },
    proxy: {
      "/api": apiProxy,
      "/registry": apiProxy,
    },
  },
  preview: {
    host: "127.0.0.1",
    port: FRONTEND_PORT,
  },
});
