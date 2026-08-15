import { useState } from "react";
import type { CatalogAgentSummary } from "@agent-kernel/viewer-core";

import { fetchProjectLogs, type RegistryProject } from "../api";

/** What the main pane shows for the selected project. */
export type ObservatoryView =
  | { kind: "traces" }
  | { kind: "agent"; agentName: string };

/** Per-project agent catalog, fetched by App for every live project. */
export type ProjectAgentsState =
  | { status: "offline" }
  | { status: "loading" }
  | { status: "ready"; agents: CatalogAgentSummary[] }
  | { status: "error"; message: string };

export interface ProjectActionState {
  kind: "start" | "stop";
  pending: boolean;
  error?: string;
}

export type ProjectLifecycleTone =
  | "success"
  | "warning"
  | "destructive"
  | "neutral";

interface ProjectSidebarProps {
  projects: RegistryProject[];
  catalogs: Record<string, ProjectAgentsState | undefined>;
  selectedProjectId: string | null;
  view: ObservatoryView;
  onSelectTraces: (projectId: string) => void;
  onSelectAgent: (projectId: string, agentName: string) => void;
  onStart: (projectId: string) => void;
  onStop: (projectId: string) => void;
  actions: Record<string, ProjectActionState | undefined>;
  onRefresh: () => void;
  refreshing: boolean;
}

export function projectLifecycle(
  project: RegistryProject,
  action?: ProjectActionState,
): { label: string; tone: ProjectLifecycleTone } {
  if (project.live) return { label: "Online", tone: "success" };
  if (
    project.managed.state === "starting"
    || (action?.pending === true && action.kind === "start")
  ) {
    return { label: "Starting…", tone: "warning" };
  }
  if (
    project.managed.state === "failed"
    || project.managed.state === "exited"
  ) {
    return { label: "Crashed", tone: "destructive" };
  }
  return { label: "Offline", tone: "neutral" };
}

export function ProjectSidebar({
  projects,
  catalogs,
  selectedProjectId,
  view,
  onSelectTraces,
  onSelectAgent,
  onStart,
  onStop,
  actions,
  onRefresh,
  refreshing,
}: ProjectSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  // Expansion is per-project UI state; groups start collapsed.
  const [expandedOverrides, setExpandedOverrides] = useState<
    Record<string, boolean>
  >({});

  return (
    <aside
      className={`flex h-full shrink-0 flex-col overflow-hidden border-r border-border bg-card transition-[width] duration-200 ${
        collapsed ? "w-12" : "w-64"
      }`}
    >
      <header
        className={`flex h-16 shrink-0 items-center border-b border-border ${
          collapsed ? "justify-center px-2" : "justify-between gap-3 px-5"
        }`}
      >
        {!collapsed ? (
          <h1 className="truncate font-display text-[15px] font-bold uppercase tracking-[0.14em]">
            Observatory
          </h1>
        ) : null}
        <button
          type="button"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((current) => !current)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[2px] border border-border font-mono text-[12px] leading-none text-muted-foreground hover:text-foreground"
        >
          <span aria-hidden>{collapsed ? "›" : "‹"}</span>
        </button>
      </header>

      {!collapsed ? <><div className="flex items-center justify-between px-4 pb-1.5 pt-3">
        <h2 className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
          Projects
        </h2>
        <button
          type="button"
          aria-label="Refresh projects"
          title="Refresh projects"
          className="flex h-[19px] w-[19px] items-center justify-center rounded-[2px] border border-border font-mono text-[10px] leading-none text-muted-foreground hover:text-foreground disabled:opacity-50"
          disabled={refreshing}
          onClick={onRefresh}
        >
          <span aria-hidden className={refreshing ? "animate-spin" : undefined}>
            ↻
          </span>
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {projects.length === 0 ? (
          <p className="px-3 py-4 font-mono text-[11px] text-muted-foreground">
            No projects registered.
          </p>
        ) : (
          <ul className="space-y-[3px]">
            {projects.map((project) => {
              const selected = project.id === selectedProjectId;
              const action = actions[project.id];
              const expanded = expandedOverrides[project.id] ?? false;
              const tracesActive = selected && view.kind === "traces";
              const catalog = catalogs[project.id] ?? { status: "offline" };
              return (
                <li key={project.id}>
                  <div
                    className={`overflow-hidden rounded-[3px] border ${
                      expanded
                        ? "border-border bg-background/30"
                        : "border-transparent"
                    }`}
                  >
                    <div
                      className={`flex min-h-[35px] items-center gap-1.5 px-1.5 ${
                        tracesActive
                          ? "bg-status-info-fill/20"
                          : "hover:bg-muted/25"
                      }`}
                    >
                      <button
                        type="button"
                        aria-label={
                          expanded ? "Collapse project" : "Expand project"
                        }
                        aria-expanded={expanded}
                        onClick={() =>
                          setExpandedOverrides((current) => ({
                            ...current,
                            [project.id]: !expanded,
                          }))
                        }
                        className={`flex w-3.5 shrink-0 justify-center font-mono text-[10px] leading-none text-muted-foreground/70 transition-transform duration-150 hover:text-foreground ${
                          expanded ? "rotate-90" : "rotate-0"
                        }`}
                      >
                        ›
                      </button>
                      <button
                        type="button"
                        aria-current={tracesActive ? "page" : undefined}
                        title={`${project.name} traces`}
                        onClick={() => onSelectTraces(project.id)}
                        className={`min-w-0 flex-1 truncate py-1.5 text-left font-mono text-[11px] font-bold transition-colors ${
                          tracesActive
                            ? "text-status-info"
                            : "text-foreground hover:text-status-info"
                        }`}
                      >
                        {project.name}
                      </button>
                      <LifecycleToggle
                        project={project}
                        action={action}
                        onStart={onStart}
                        onStop={onStop}
                      />
                    </div>

                    {action?.error ? (
                      <p className="border-t border-border/70 px-2.5 py-1.5 font-mono text-[9px] leading-4 text-destructive">
                        {action.error}
                      </p>
                    ) : null}

                    {project.managed.state === "failed"
                    || project.managed.state === "exited" ? (
                      <ProjectLogsDisclosure
                        projectId={project.id}
                        exitCode={project.managed.exitCode}
                      />
                    ) : null}

                    {expanded ? (
                      <AgentList
                        project={project}
                        catalog={catalog}
                        selectedAgentName={
                          selected && view.kind === "agent"
                            ? view.agentName
                            : null
                        }
                        onSelectAgent={onSelectAgent}
                      />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
      </> : null}
    </aside>
  );
}

/**
 * The lifecycle control doubles as the status indicator, colored by the
 * action it performs: a red stop square means the project is running (click
 * stops it), a green play glyph starts it. There is deliberately no textual
 * Online/Offline badge.
 */
function LifecycleToggle({
  project,
  action,
  onStart,
  onStop,
}: {
  project: RegistryProject;
  action?: ProjectActionState;
  onStart: (projectId: string) => void;
  onStop: (projectId: string) => void;
}) {
  const pending = action?.pending === true;
  const supervisorOwned = project.managed.pid !== undefined;
  const starting =
    project.managed.state === "starting"
    || (pending && action?.kind === "start");
  const crashed =
    project.managed.state === "failed" || project.managed.state === "exited";

  const base =
    "flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-[2px] border font-mono text-[9px] leading-none transition-colors disabled:opacity-60";

  if (starting) {
    return (
      <button
        type="button"
        disabled
        title="Starting…"
        aria-label={`${project.name} starting`}
        className={`${base} animate-pulse border-status-warning-border bg-status-warning-fill/30 text-status-warning`}
      >
        ▶
      </button>
    );
  }

  if (project.live || supervisorOwned) {
    return (
      <button
        type="button"
        disabled={pending || !supervisorOwned}
        title={
          supervisorOwned
            ? "Running — click to stop"
            : "Running (started outside Observatory)"
        }
        aria-label={`Stop ${project.name}`}
        onClick={() => onStop(project.id)}
        className={`${base} border-destructive/40 bg-destructive/10 text-destructive ${
          supervisorOwned ? "hover:bg-destructive/20" : ""
        }`}
      >
        ■
      </button>
    );
  }

  if (project.launchable) {
    return (
      <button
        type="button"
        disabled={pending}
        title={crashed ? "Crashed — click to restart" : "Start"}
        aria-label={`Start ${project.name}`}
        onClick={() => onStart(project.id)}
        className={`${base} border-status-success-border bg-status-success-fill/30 text-status-success hover:bg-status-success-fill/50`}
      >
        ▶
      </button>
    );
  }

  return null;
}

function AgentList({
  project,
  catalog,
  selectedAgentName,
  onSelectAgent,
}: {
  project: RegistryProject;
  catalog: ProjectAgentsState;
  selectedAgentName: string | null;
  onSelectAgent: (projectId: string, agentName: string) => void;
}) {
  if (catalog.status === "offline") return null;

  if (catalog.status === "loading") {
    return (
      <p className="border-t border-border/70 px-5 py-1.5 font-mono text-[10px] text-muted-foreground">
        Loading agents…
      </p>
    );
  }
  if (catalog.status === "error") {
    return (
      <p className="border-t border-border/70 px-5 py-1.5 font-mono text-[9px] leading-4 text-destructive">
        {catalog.message}
      </p>
    );
  }
  if (catalog.agents.length === 0) {
    return (
      <p className="border-t border-border/70 px-5 py-1.5 font-mono text-[10px] text-muted-foreground">
        No agents registered.
      </p>
    );
  }

  return (
    <ul className="border-t border-border/70 p-1">
      {catalog.agents.map((agent) => {
        const active = agent.name === selectedAgentName;
        return (
          <li key={agent.name}>
            <button
              type="button"
              aria-current={active ? "page" : undefined}
              title={agent.valid ? agent.name : `${agent.name} — invalid bundle`}
              onClick={() => onSelectAgent(project.id, agent.name)}
              className={`w-full truncate rounded-[2px] border py-[7px] pl-5 pr-2 text-left font-mono text-[11px] transition-colors ${
                active
                  ? "border-status-info-border/50 bg-status-info-fill/30 text-foreground"
                  : `border-transparent hover:bg-muted/30 hover:text-foreground ${
                      agent.valid ? "text-muted-foreground" : "text-destructive"
                    }`
              }`}
            >
              {agent.name}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ProjectLogsDisclosure({
  projectId,
  exitCode,
}: {
  projectId: string;
  exitCode?: number;
}) {
  const [state, setState] = useState<
    | { status: "idle" | "loading"; lines: string[] }
    | { status: "ready"; lines: string[] }
    | { status: "error"; lines: string[]; message: string }
  >({ status: "idle", lines: [] });

  return (
    <details
      className="border-t border-border/70 bg-destructive/5 px-2.5 py-1.5 font-mono"
      onToggle={(event) => {
        if (!event.currentTarget.open || state.status !== "idle") return;
        setState({ status: "loading", lines: [] });
        void fetchProjectLogs(projectId)
          .then((lines) => setState({ status: "ready", lines }))
          .catch((error: unknown) =>
            setState({
              status: "error",
              lines: [],
              message: error instanceof Error ? error.message : "Logs unavailable.",
            }),
          );
      }}
    >
      <summary className="cursor-pointer text-[9px] font-bold uppercase tracking-[0.08em] text-destructive">
        Logs{exitCode !== undefined ? ` · exit ${exitCode}` : ""}
      </summary>
      {state.status === "loading" ? (
        <p className="mt-2 text-[9px] text-muted-foreground">Loading…</p>
      ) : state.status === "error" ? (
        <p className="mt-2 text-[9px] leading-4 text-destructive">
          {state.message}
        </p>
      ) : state.status === "ready" ? (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-[2px] border border-border bg-background p-2 text-[9px] leading-4 text-muted-foreground">
          {state.lines.length > 0 ? state.lines.join("\n") : "No output captured."}
        </pre>
      ) : null}
    </details>
  );
}
