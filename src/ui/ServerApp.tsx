import { SidebarShell, type RunTarget } from "@codecaine-ai/agent-kernel-viewer-shell";
import { SESSION_READ_PATHS, type RunSessionAnswer } from "@codecaine-ai/agent-kernel-viewer-core";
import { isPlainClick, useJsonResource } from "@codecaine-ai/agent-kernel-viewer-ui";

import { ENGINE_RUNS_API_PREFIX } from "./api";
import { RunsPage } from "./pages/RunsPage";
import { routePath, serverRoute, useRoute, type Route } from "./router";
import type { Theme } from "./useTheme";

interface ServerAppProps {
  theme: Theme;
  onToggleTheme: () => void;
}

const ICON_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const SunIcon = () => (
  <svg {...ICON_PROPS}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);

const MoonIcon = () => (
  <svg {...ICON_PROPS}>
    <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
  </svg>
);

const runRoute = (run: RunTarget): Route => ({ page: "runs", run });

/**
 * The server mode shell. Work, a Session tree, Orphans, Unlinked calls and
 * Workflows render in the viewer-shell sidebar shell, which reads the
 * Session routes under /api. A run opens the Runs page at
 * /runs/:engine/:runId inside the same shell, under the Workflows item, and
 * links back to the Session that holds the run.
 */
export function ServerApp({ theme, onToggleTheme }: ServerAppProps) {
  const [route, navigate] = useRoute();
  const page = serverRoute(route);
  const nextTheme = theme === "dark" ? "light" : "dark";
  // The theme switch sits at the foot of the sidebar, as a nav row: the icon shows the theme it switches to.
  const themeButton = (
    <button
      type="button"
      className="ds-nav-item w-full"
      data-theme-toggle=""
      onClick={onToggleTheme}
      title={`Switch to the ${nextTheme} theme`}
      aria-label={`Switch to the ${nextTheme} theme`}
    >
      <span className="ds-nav-icon" aria-hidden="true">
        {nextTheme === "light" ? <SunIcon /> : <MoonIcon />}
      </span>
      <span className="ds-nav-label">{nextTheme === "light" ? "Light mode" : "Dark mode"}</span>
    </button>
  );
  const isRun = page.page === "runs";

  return (
    // The shell scrolls the document, and the body does not scroll, so this box scrolls in its place.
    <div className="h-full overflow-y-auto">
      <SidebarShell
        route={isRun ? { page: "workflows" } : page}
        routeHref={routePath}
        onNavigate={navigate}
        runHref={(run) => routePath(runRoute(run))}
        onOpenRun={(run) => navigate(runRoute(run))}
        apiBase={ENGINE_RUNS_API_PREFIX}
        appName="Traces"
        storageKey="observatory.sidebar"
        footer={themeButton}
        hostPage={
          isRun
            ? {
                item: "workflows",
                title: page.run ? "Workflow run" : "Engine runs",
                fill: true,
                content: (
                  <div className="flex min-h-0 flex-1 flex-col p-4" data-trace-shell="run">
                    <RunsPage
                      run={page.run}
                      onOpen={(next) => navigate({ page: "runs", run: next })}
                      detailExtras={(run) => <RunSessionLink run={run} navigate={navigate} />}
                    />
                  </div>
                ),
              }
            : undefined
        }
      />
    </div>
  );
}

/** The Session page of a run, with its run node selected, or null when no Session holds the run. */
export function runSessionRoute(answer: RunSessionAnswer): Extract<Route, { page: "session" }> | null {
  return answer.session === null ? null : { page: "session", sessionId: answer.session.id, node: answer.node };
}

/** The link from a run to its Session, with the run node selected. Nothing shows while the read is on its way or when no Session holds the run. */
function RunSessionLink({ run, navigate }: { run: RunTarget; navigate: (next: Route) => void }) {
  const answer = useJsonResource<RunSessionAnswer>(`${ENGINE_RUNS_API_PREFIX}${SESSION_READ_PATHS.runSession(run.engine, run.runId)}`, 0);
  const target = answer.phase === "loaded" ? runSessionRoute(answer.data) : null;
  if (answer.phase !== "loaded" || target === null || answer.data.session === null) return null;
  const session = answer.data.session;
  const href = routePath(target);
  return (
    <a
      href={href}
      data-run-session-link={session.id}
      title={`Open the Session ${session.title}, with this run selected`}
      className="ds-shell-button min-w-0 no-underline"
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        navigate(target);
      }}
    >
      <span aria-hidden="true">‹</span>
      <span className="min-w-0 truncate">Session: {session.title}</span>
    </a>
  );
}
