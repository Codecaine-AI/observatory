import type { ReactNode } from "react";
import { SidebarShell, type RunTarget } from "@codecaine-ai/agent-kernel-viewer-shell";
import { Chip } from "@codecaine-ai/agent-kernel-viewer-ui";

import { ENGINE_RUNS_API_PREFIX } from "./api";
import { RunsPage } from "./pages/RunsPage";
import { isPlainLeftClick, routePath, serverRoute, useRoute, type Route } from "./router";
import type { Theme } from "./useTheme";

interface ServerAppProps {
  theme: Theme;
  onToggleTheme: () => void;
}

const runRoute = (run: RunTarget): Route => ({ page: "runs", run });

/**
 * The server mode shell. Work, a Session tree and Workflows render in the
 * viewer-shell sidebar shell, which reads the Session routes under /api. A
 * run opens the existing Runs page at /runs/:engine/:runId.
 */
export function ServerApp({ theme, onToggleTheme }: ServerAppProps) {
  const [route, navigate] = useRoute();
  const page = serverRoute(route);
  const themeButton = (
    <button type="button" className="ds-shell-button" data-theme-toggle="" onClick={onToggleTheme}>
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  );

  if (page.page === "runs") {
    return <RunFrame run={page.run} navigate={navigate} actions={themeButton} />;
  }

  return (
    // The shell scrolls the document, and the body does not scroll, so this box scrolls in its place.
    <div className="h-full overflow-y-auto">
      <SidebarShell
        route={page}
        routeHref={routePath}
        onNavigate={navigate}
        runHref={(run) => routePath(runRoute(run))}
        onOpenRun={(run) => navigate(runRoute(run))}
        apiBase={ENGINE_RUNS_API_PREFIX}
        appName="Traces"
        storageKey="observatory.sidebar"
        actions={themeButton}
      />
    </div>
  );
}

/** The Runs page under a topbar with a link back to the Workflows tab. */
function RunFrame({
  run,
  navigate,
  actions,
}: {
  run: RunTarget | null;
  navigate: (next: Route) => void;
  actions: ReactNode;
}) {
  const workflows: Route = { page: "workflows" };
  return (
    <div className="flex h-full min-w-0 flex-col bg-background text-foreground" data-trace-shell="run">
      <header className="ds-topbar">
        <a
          href={routePath(workflows)}
          className="ds-shell-button no-underline"
          data-back-to-workflows=""
          onClick={(event) => {
            if (!isPlainLeftClick(event)) return;
            event.preventDefault();
            navigate(workflows);
          }}
        >
          ‹ Workflows
        </a>
        <h1 className="ds-topbar-title">Workflow run</h1>
        <div className="ds-topbar-actions">
          <Chip tone="neutral" kind="read-only" title="The viewer reads with a read-only user and writes nothing.">
            Read-only
          </Chip>
          {actions}
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-hidden p-4">
        <RunsPage run={run} onOpen={(next) => navigate({ page: "runs", run: next })} />
      </main>
    </div>
  );
}
