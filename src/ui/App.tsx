import { useCallback, useEffect, useState } from "react";

import {
  fetchRegistryProjects,
  launchRegistryProject,
  stopRegistryProject,
  type RegistryProject,
} from "./api";
import {
  ProjectSidebar,
  type ProjectActionState,
} from "./components/ProjectSidebar";
import { ActionsPage } from "./pages/ActionsPage";

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
              Every MCP tool call on this machine
            </p>
            <h2 className="truncate font-display text-[16px] font-bold">Action log</h2>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden p-4">
          <ActionsPage />
        </div>
      </main>
    </div>
  );
}
