import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

const UI_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(UI_DIR, "../..");

/** Linked TypeScript-source packages: served from their real folders, never pre-bundled. */
const LINKED_SOURCE_PACKAGES = [
  "@codecaine-ai/agent-kernel-viewer-core",
  "@codecaine-ai/agent-kernel-viewer-ui",
  "@codecaine-ai/agent-kernel-viewer-shell",
  "@codecaine-ai/agent-kernel-viewer-read-service",
  "@codecaine-ai/prompt-kit",
];
const LINKED_SOURCE_DIRS = LINKED_SOURCE_PACKAGES.map((name) =>
  realpathSync(resolve(REPO_ROOT, "node_modules", name)),
);

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

export default defineConfig(({ command }) => ({
  root: UI_DIR,
  appType: "spa",
  plugins: [react()],
  define: {
    // The API the dev server proxies to, for the local sidebar. A build is served beside the API at the same origin.
    __OBSERVATORY_API_TARGET__: JSON.stringify(command === "serve" ? API_TARGET : ""),
  },
  css: {
    postcss: { plugins: [tailwindcss()] },
  },
  resolve: {
    // The viewer packages import each other; resolve them from Observatory's links only.
    dedupe: ["react", "react-dom", ...LINKED_SOURCE_PACKAGES],
  },
  optimizeDeps: {
    exclude: LINKED_SOURCE_PACKAGES,
  },
  server: {
    host: "127.0.0.1",
    port: FRONTEND_PORT,
    strictPort: true,
    fs: {
      allow: [REPO_ROOT, ...LINKED_SOURCE_DIRS],
    },
    proxy: {
      // The trailing slash keeps the proxy off the UI module /api.ts.
      "/api/": apiProxy,
      "/registry": apiProxy,
    },
  },
  preview: {
    host: "127.0.0.1",
    port: FRONTEND_PORT,
  },
}));
