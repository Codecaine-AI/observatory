import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
} from "react";

import {
  fetchRegistryProjects,
  launchRegistryProject,
  stopRegistryProject,
  type RegistryProject,
} from "./api";
import {
  ProjectSidebar,
  projectLifecycle,
  type ProjectActionState,
} from "./components/ProjectSidebar";
import { ActionsPage } from "./pages/ActionsPage";
import { TracesPage } from "./pages/TracesPage";
import { isPlainLeftClick, routePath, useRoute, type Route } from "./router";
import { resolveTracesProject } from "./tracesProject";

type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "observatory.theme";

function loadTheme(): Theme {
  return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
}

type ProjectState =
  | { status: "loading"; projects: RegistryProject[] }
  | { status: "ready"; projects: RegistryProject[] }
  | { status: "error"; projects: RegistryProject[]; message: string };

export function App() {
  const [projectState, setProjectState] = useState<ProjectState>({
    status: "loading",
    projects: [],
  });
  const [projectActions, setProjectActions] = useState<
    Record<string, ProjectActionState | undefined>
  >({});
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [route, navigate] = useRoute();

  const refreshProjects = useCallback(async (quiet = false) => {
    if (!quiet) {
      setProjectState((current) => ({
        status: "loading",
        projects: current.projects,
      }));
    }
    try {
      const projects = await fetchRegistryProjects();
      setProjectState({ status: "ready", projects });
    } catch (cause) {
      setProjectState((current) => ({
        status: "error",
        projects: current.projects,
        message:
          cause instanceof Error ? cause.message : "Project registry unavailable.",
      }));
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
    const interval = window.setInterval(() => {
      void refreshProjects(true);
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [refreshProjects]);

  const hasStartingProject = projectState.projects.some(
    (project) => project.managed.state === "starting",
  ) || Object.values(projectActions).some(
    (action) => action?.pending === true && action.kind === "start",
  );

  useEffect(() => {
    if (!hasStartingProject) return;
    const interval = window.setInterval(() => {
      void refreshProjects(true);
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [hasStartingProject, refreshProjects]);

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const tracesProject = useMemo(
    () =>
      route.page === "traces"
        ? resolveTracesProject(
            projectState.projects,
            route.projectId,
            projectState.status === "loading",
          )
        : null,
    [projectState.projects, projectState.status, route],
  );
  const activeProject =
    tracesProject?.kind === "project" ? tracesProject.project : null;

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  const runProjectAction = useCallback(
    async (projectId: string, kind: "start" | "stop") => {
      setProjectActions((current) => ({
        ...current,
        [projectId]: { kind, pending: true },
      }));
      try {
        const managed =
          kind === "start"
            ? await launchRegistryProject(projectId)
            : await stopRegistryProject(projectId);
        setProjectState((current) => ({
          ...current,
          projects: current.projects.map((project) =>
            project.id === projectId ? { ...project, managed } : project,
          ),
        }));
        setProjectActions((current) => ({
          ...current,
          [projectId]: undefined,
        }));
        await refreshProjects(true);
      } catch (cause) {
        setProjectActions((current) => ({
          ...current,
          [projectId]: {
            kind,
            pending: false,
            error: cause instanceof Error ? cause.message : "Project action failed.",
          },
        }));
        await refreshProjects(true);
      }
    },
    [refreshProjects],
  );

  return (
    <div className="flex h-screen min-w-0 bg-background text-foreground">
      <ProjectSidebar
        projects={projectState.projects}
        error={projectState.status === "error" ? projectState.message : null}
        selectedProjectId={activeProject?.id ?? null}
        onOpenTraces={(projectId) => navigate({ page: "traces", projectId })}
        onStart={(projectId) => void runProjectAction(projectId, "start")}
        onStop={(projectId) => void runProjectAction(projectId, "stop")}
        actions={projectActions}
        theme={theme}
        onToggleTheme={toggleTheme}
        onRefresh={() => void refreshProjects()}
        refreshing={projectState.status === "loading"}
      />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-5">
          <div className="min-w-0">
            <p className="font-mono text-(length:--ds-font-size-ui-2xs) font-bold uppercase tracking-[0.18em] text-muted-foreground">
              {route.page === "traces"
                ? "Kernel traces"
                : "Every MCP tool call on this machine"}
            </p>
            <h2 className="truncate font-display text-[16px] font-bold">
              {route.page === "traces"
                ? activeProject?.name ??
                  (tracesProject?.kind === "not-found"
                    ? tracesProject.projectId
                    : "No project selected")
                : "Action log"}
            </h2>
          </div>
          {activeProject ? (
            <span
              className={`rounded-[2px] border px-1.5 py-0.5 font-mono text-(length:--ds-font-size-ui-2xs) font-bold uppercase tracking-[0.08em] ${headerBadgeClass(
                projectLifecycle(activeProject, projectActions[activeProject.id]).tone,
              )}`}
            >
              {projectLifecycle(activeProject, projectActions[activeProject.id]).label}
            </span>
          ) : null}
          <nav aria-label="Pages" className="ml-auto flex items-center gap-1">
            <PageLink
              active={route.page === "actions"}
              to={{ page: "actions" }}
              navigate={navigate}
            >
              Action log
            </PageLink>
            <PageLink
              active={route.page === "traces"}
              to={{
                page: "traces",
                projectId: projectState.projects[0]?.id ?? null,
              }}
              navigate={navigate}
            >
              Traces
            </PageLink>
          </nav>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden p-4">
          {route.page === "actions" ? (
            <ActionsPage />
          ) : projectState.status === "error" && projectState.projects.length === 0 ? (
            <CenteredMessage tone="error">{projectState.message}</CenteredMessage>
          ) : tracesProject?.kind === "loading" ? (
            <CenteredMessage>Loading projects…</CenteredMessage>
          ) : tracesProject?.kind === "not-found" ? (
            <CenteredMessage tone="error">
              {`Project not found: "${tracesProject.projectId}" is not in registry.json.`}
            </CenteredMessage>
          ) : !activeProject ? (
            <CenteredMessage>
              Add a project to registry.json, then refresh.
            </CenteredMessage>
          ) : (
            <TracesPage key={activeProject.id} project={activeProject} />
          )}
        </div>
      </main>
    </div>
  );
}

function PageLink({
  active,
  to,
  navigate,
  children,
}: {
  active: boolean;
  to: Route;
  navigate: (next: Route) => void;
  children: string;
}) {
  return (
    <a
      href={routePath(to)}
      aria-current={active ? "page" : undefined}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        navigate(to);
      }}
      className={`flex h-(--ds-control-height-lg) items-center rounded-[2px] border px-2 font-mono text-(length:--ds-font-size-ui-2xs) font-bold uppercase tracking-[0.08em] transition-colors ${
        active
          ? "border-status-info-border bg-status-info-fill/20 text-status-info"
          : "border-border text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </a>
  );
}

function headerBadgeClass(
  tone: ReturnType<typeof projectLifecycle>["tone"],
): string {
  if (tone === "success") {
    return "border-status-success-border bg-status-success-fill/30 text-status-success";
  }
  if (tone === "warning") {
    return "border-status-warning-border bg-status-warning-fill/30 text-status-warning";
  }
  if (tone === "destructive") {
    return "border-destructive/40 bg-destructive/10 text-destructive";
  }
  return "border-status-neutral-border bg-status-neutral-fill text-status-neutral";
}

function CenteredMessage({
  children,
  tone = "muted",
}: {
  children: string;
  tone?: "muted" | "error";
}) {
  return (
    <div className="flex h-full items-center justify-center rounded-[3px] border border-border bg-card p-6 font-mono">
      <p className={tone === "error" ? "text-(length:--ds-font-size-ui-xs) text-destructive" : "text-(length:--ds-font-size-ui-xs) text-muted-foreground"}>
        {children}
      </p>
    </div>
  );
}
