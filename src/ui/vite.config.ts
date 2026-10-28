import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const UI_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(UI_DIR, "../..");
const AGENT_KERNEL_DIR = resolve(REPO_ROOT, "../agent-kernel");
const CANVAS_DIR = resolve(REPO_ROOT, "../canvas");
const PROMPT_KIT_DIR = resolve(REPO_ROOT, "../prompt-kit");

const LINKED_SOURCE_PACKAGES = [
  "@codecaine-ai/agent-kernel-viewer-core",
  "@codecaine-ai/agent-kernel-viewer-ui",
  "@codecaine-ai/agent-kernel-viewer-shell",
  "@codecaine-ai/canvas-agent",
  "@codecaine-ai/prompt-kit",
];

const API_TARGET = process.env.API_TARGET ?? "http://127.0.0.1:4890";
const FRONTEND_PORT = Number.parseInt(process.env.FRONTEND_PORT ?? "4891", 10);

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
  optimizeDeps: {
    exclude: LINKED_SOURCE_PACKAGES,
  },
  server: {
    host: "127.0.0.1",
    port: FRONTEND_PORT,
    strictPort: true,
    fs: {
      allow: [REPO_ROOT, AGENT_KERNEL_DIR, CANVAS_DIR, PROMPT_KIT_DIR],
    },
    proxy: {
      "/registry": {
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
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: FRONTEND_PORT,
  },
});
