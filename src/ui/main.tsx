import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@codecaine-ai/design-system/tokens.css";
// The app shell classes (ds-shell, ds-sidebar, ds-topbar) of the server mode sidebar shell.
import "@codecaine-ai/design-system/layout.css";
import "@codecaine-ai/design-system/host-contract.css";
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
