import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import {
  StyleOverlay,
  loadStyleSettings,
  saveStyleSettings,
  styleEffectClass,
  styleVars,
  type StyleSettings,
  type StyleSystemConfig,
} from "@codecaine-ai/agent-kernel-viewer-shell";

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
  type ObservatorySection,
} from "./components/ProjectSidebar";
import { AgentsPage } from "./pages/AgentsPage";
import { TracesPage } from "./pages/TracesPage";

const STYLE_CONFIG: StyleSystemConfig = {
  settingsStorageKey: "observatory.viewerStyle.v1",
  railCollapsedStorageKey: "observatory.viewerStyleRailCollapsed",
  railWidthStorageKey: "observatory.viewerStyleRailWidth",
  defaultTheme: "dark",
  neutralTokenFormat: "hex",
};

type ProjectState =
  | { status: "loading"; projects: RegistryProject[] }
  | { status: "ready"; projects: RegistryProject[] }
  | { status: "error"; projects: RegistryProject[]; message: string };

export function App() {
  const [projectState, setProjectState] = useState<ProjectState>({
    status: "loading",
    projects: [],
  });
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [section, setSection] = useState<ObservatorySection>("traces");
  const [projectActions, setProjectActions] = useState<
    Record<string, ProjectActionState | undefined>
  >({});
  const [styleSettings, setStyleSettings] = useState<StyleSettings>(() =>
    loadStyleSettings(STYLE_CONFIG),
  );

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
      setSelectedProjectId((current) =>
        current && projects.some((project) => project.id === current)
          ? current
          : projects[0]?.id ?? null,
      );
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
    saveStyleSettings(STYLE_CONFIG, styleSettings);
    document.documentElement.dataset.theme = styleSettings.theme;
    document.documentElement.style.colorScheme = styleSettings.theme;
  }, [styleSettings]);

  const activeProject = useMemo(
    () =>
      projectState.projects.find((project) => project.id === selectedProjectId) ??
      projectState.projects[0] ??
      null,
    [projectState.projects, selectedProjectId],
  );

  const toggleTheme = useCallback(() => {
    setStyleSettings((current) => ({
      ...current,
      theme: current.theme === "dark" ? "light" : "dark",
    }));
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

  const shellStyle = styleVars(styleSettings, STYLE_CONFIG) as CSSProperties;

  return (
    <div
      className={`research-style-shell ${styleEffectClass(styleSettings)} flex h-screen min-w-0 bg-background text-foreground`}
      style={shellStyle}
    >
      <ProjectSidebar
        projects={projectState.projects}
        selectedProjectId={activeProject?.id ?? null}
        section={section}
        onSelect={(projectId, nextSection) => {
          setSelectedProjectId(projectId);
          setSection(nextSection);
        }}
        onStart={(projectId) => void runProjectAction(projectId, "start")}
        onStop={(projectId) => void runProjectAction(projectId, "stop")}
        actions={projectActions}
        theme={styleSettings.theme}
        onToggleTheme={toggleTheme}
        onRefresh={() => void refreshProjects()}
        refreshing={projectState.status === "loading"}
      />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-5">
          <div className="min-w-0">
            <p className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
              {section}
            </p>
            <h2 className="truncate font-display text-[16px] font-bold">
              {activeProject?.name ?? "No project selected"}
            </h2>
          </div>
          {activeProject ? (
            <span
              className={`ml-auto rounded-[2px] border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.08em] ${headerBadgeClass(
                projectLifecycle(activeProject, projectActions[activeProject.id]).tone,
              )}`}
            >
              {projectLifecycle(activeProject, projectActions[activeProject.id]).label}
            </span>
          ) : null}
        </header>

        <div className="min-h-0 flex-1 overflow-hidden p-4">
          {projectState.status === "error" && projectState.projects.length === 0 ? (
            <CenteredMessage tone="error">{projectState.message}</CenteredMessage>
          ) : !activeProject ? (
            <CenteredMessage>
              Add a project to registry.json, then refresh.
            </CenteredMessage>
          ) : section === "agents" ? (
            <AgentsPage key={activeProject.id} project={activeProject} />
          ) : (
            <TracesPage key={activeProject.id} project={activeProject} />
          )}
        </div>
      </main>
      <StyleOverlay settings={styleSettings.grain} />
    </div>
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
      <p className={tone === "error" ? "text-[12px] text-destructive" : "text-[11px] text-muted-foreground"}>
        {children}
      </p>
    </div>
  );
}
