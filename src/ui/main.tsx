import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@codecaine-ai/agent-kernel-viewer-ui/styles";
import "@codecaine-ai/agent-kernel-viewer-shell/styles";
import "./index.css";

import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root mount element.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
