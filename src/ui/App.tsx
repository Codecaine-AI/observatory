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
} from "@agent-kernel/viewer-shell";

import {
  fetchCatalogAgents,
  fetchRegistryProjects,
  launchRegistryProject,
  stopRegistryProject,
  type RegistryProject,
} from "./api";
import {
  ProjectSidebar,
  type ObservatoryView,
  type ProjectActionState,
  type ProjectAgentsState,
} from "./components/ProjectSidebar";
import { AgentPage } from "./pages/AgentPage";
import { TracesPage } from "./pages/TracesPage";
import { agentPath, projectPath, tracePath, useRoute } from "./router";

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
  const { route, navigate } = useRoute();
  const [projectState, setProjectState] = useState<ProjectState>({
    status: "loading",
    projects: [],
  });
  const [catalogs, setCatalogs] = useState<
    Record<string, ProjectAgentsState | undefined>
  >({});
  const [catalogNonce, setCatalogNonce] = useState(0);
  const [projectActions, setProjectActions] = useState<
    Record<string, ProjectActionState | undefined>
  >({});
  const [styleSettings] = useState<StyleSettings>(() => ({
    ...loadStyleSettings(STYLE_CONFIG),
    theme: "dark",
  }));

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

  // Agent catalogs feed the sidebar tree. Refetch when a project's liveness
  // flips (harness came up or went down) or on an explicit refresh.
  const liveSignature = projectState.projects
    .map((project) => `${project.id}:${project.live ? 1 : 0}`)
    .join(",");

  useEffect(() => {
    if (liveSignature.length === 0) return;
    const controller = new AbortController();
    const projects = liveSignature.split(",").map((entry) => {
      const [id = "", live] = entry.split(":");
      return { id, live: live === "1" };
    });

    setCatalogs((current) => {
      const next: Record<string, ProjectAgentsState | undefined> = {};
      for (const { id, live } of projects) {
        next[id] = live
          ? current[id]?.status === "ready"
            ? current[id]
            : { status: "loading" }
          : { status: "offline" };
      }
      return next;
    });

    for (const { id, live } of projects) {
      if (!live) continue;
      void fetchCatalogAgents(id, controller.signal)
        .then((body) => {
          if (!Array.isArray(body.agents)) {
            throw new Error("Agent catalog returned an invalid agent list.");
          }
          setCatalogs((current) => ({
            ...current,
            [id]: { status: "ready", agents: body.agents },
          }));
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setCatalogs((current) => ({
            ...current,
            [id]: {
              status: "error",
              message:
                cause instanceof Error ? cause.message : "Agent catalog unavailable.",
            },
          }));
        });
    }
    return () => controller.abort();
  }, [liveSignature, catalogNonce]);

  useEffect(() => {
    saveStyleSettings(STYLE_CONFIG, styleSettings);
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  }, [styleSettings]);

  // Routing invariants, applied once the registry has answered: "/" lands on
  // the first project; an unknown project id falls back to "/".
  useEffect(() => {
    if (projectState.status !== "ready" || projectState.projects.length === 0) {
      return;
    }
    if (route.kind === "home") {
      const first = projectState.projects[0];
      if (first) navigate(projectPath(first.id), { replace: true });
      return;
    }
    const known = projectState.projects.some(
      (project) => project.id === route.projectId,
    );
    if (!known) navigate("/", { replace: true });
  }, [route, projectState, navigate]);

  const activeProject = useMemo(
    () =>
      route.kind === "home"
        ? projectState.projects[0] ?? null
        : projectState.projects.find(
            (project) => project.id === route.projectId,
          ) ?? null,
    [projectState.projects, route],
  );

  // An agent page only makes sense while its agent exists in the live
  // catalog; fall back to the project page when the harness goes down or the
  // agent disappears.
  useEffect(() => {
    if (route.kind !== "agent" || !activeProject) return;
    const catalog = catalogs[activeProject.id];
    if (!catalog || catalog.status === "loading") return;
    const exists =
      catalog.status === "ready"
      && catalog.agents.some((agent) => agent.name === route.agentName);
    if (!exists) navigate(projectPath(activeProject.id), { replace: true });
  }, [route, activeProject, catalogs, navigate]);

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

  const view: ObservatoryView =
    route.kind === "agent"
      ? { kind: "agent", agentName: route.agentName }
      : { kind: "traces" };

  const activeCatalog = activeProject ? catalogs[activeProject.id] : undefined;
  const activeAgent =
    route.kind === "agent" && activeCatalog?.status === "ready"
      ? activeCatalog.agents.find((agent) => agent.name === route.agentName)
        ?? null
      : null;

  const sectionLabel =
    route.kind === "agent" ? "agent" : route.kind === "trace" ? "trace" : "traces";
  const title = activeProject
    ? route.kind === "agent"
      ? `${activeProject.name} / ${route.agentName}`
      : route.kind === "trace"
        ? `${activeProject.name} / ${route.traceId}`
        : activeProject.name
    : "No project selected";

  const shellStyle = styleVars(styleSettings, STYLE_CONFIG) as CSSProperties;

  return (
    <div
      className={`research-style-shell ${styleEffectClass(styleSettings)} flex h-screen min-w-0 bg-background text-foreground`}
      style={shellStyle}
    >
      <ProjectSidebar
        projects={projectState.projects}
        catalogs={catalogs}
        selectedProjectId={activeProject?.id ?? null}
        view={view}
        onSelectTraces={(projectId) => navigate(projectPath(projectId))}
        onSelectAgent={(projectId, agentName) =>
          navigate(agentPath(projectId, agentName))
        }
        onStart={(projectId) => void runProjectAction(projectId, "start")}
        onStop={(projectId) => void runProjectAction(projectId, "stop")}
        actions={projectActions}
        onRefresh={() => {
          setCatalogNonce((nonce) => nonce + 1);
          void refreshProjects();
        }}
        refreshing={projectState.status === "loading"}
      />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-5">
          <div className="min-w-0">
            <p className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
              {sectionLabel}
            </p>
            <h2 className="truncate font-display text-[16px] font-bold">
              {title}
            </h2>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden p-4">
          {projectState.status === "error" && projectState.projects.length === 0 ? (
            <CenteredMessage tone="error">{projectState.message}</CenteredMessage>
          ) : !activeProject ? (
            <CenteredMessage>
              Add a project to registry.json, then refresh.
            </CenteredMessage>
          ) : route.kind === "agent" && activeAgent ? (
            <AgentPage
              key={`${activeProject.id}:${activeAgent.name}`}
              project={activeProject}
              agent={activeAgent}
            />
          ) : route.kind === "agent" ? (
            <CenteredMessage>Loading agent…</CenteredMessage>
          ) : (
            <TracesPage
              key={activeProject.id}
              project={activeProject}
              selectedTraceId={route.kind === "trace" ? route.traceId : null}
              onSelectTrace={(traceId) =>
                navigate(
                  traceId
                    ? tracePath(activeProject.id, traceId)
                    : projectPath(activeProject.id),
                )
              }
            />
          )}
        </div>
      </main>
      <StyleOverlay settings={styleSettings.grain} />
    </div>
  );
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
