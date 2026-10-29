import { useState } from "react";

import { fetchProjectLogs, type RegistryProject } from "../api";

export type ObservatorySection = "agents" | "traces";

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
  selectedProjectId: string | null;
  section: ObservatorySection;
  onSelect: (projectId: string, section: ObservatorySection) => void;
  onStart: (projectId: string) => void;
  onStop: (projectId: string) => void;
  actions: Record<string, ProjectActionState | undefined>;
  theme: "light" | "dark";
  onToggleTheme: () => void;
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
  selectedProjectId,
  section,
  onSelect,
  onStart,
  onStop,
  actions,
  theme,
  onToggleTheme,
  onRefresh,
  refreshing,
}: ProjectSidebarProps) {
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <p className="font-mono text-(length:--ds-font-size-ui-2xs) font-bold uppercase tracking-[0.22em] text-muted-foreground">
          Local development
        </p>
        <h1 className="mt-1 font-display text-[15px] font-bold uppercase tracking-[0.14em]">
          Observatory
        </h1>
      </header>

      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <h2 className="font-mono text-(length:--ds-font-size-ui-2xs) font-bold uppercase tracking-[0.16em] text-muted-foreground">
          Projects
        </h2>
        <button
          type="button"
          className="flex h-(--ds-control-height-lg) items-center rounded-[2px] border border-border px-2 font-mono text-(length:--ds-font-size-ui-2xs) uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground disabled:opacity-50"
          disabled={refreshing}
          onClick={onRefresh}
        >
          {refreshing ? "Checking" : "Refresh"}
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {projects.length === 0 ? (
          <p className="px-2 py-4 font-mono text-(length:--ds-font-size-ui-xs) text-muted-foreground">
            No projects registered.
          </p>
        ) : (
          <ul className="space-y-2">
            {projects.map((project) => {
              const selected = project.id === selectedProjectId;
              const action = actions[project.id];
              const lifecycle = projectLifecycle(project, action);
              const supervisorOwned = project.managed.pid !== undefined;
              const showStart =
                !project.live
                && !supervisorOwned
                && project.managed.state !== "starting"
                && project.launchable;
              return (
                <li
                  key={project.id}
                  className={`overflow-hidden rounded-[3px] border ${
                    selected
                      ? "border-status-info-border bg-status-info-fill/20"
                      : "border-border bg-background/30"
                  }`}
                >
                  <div className="flex items-center gap-2 border-b border-border/70 px-2.5 py-2">
                    <span
                      aria-hidden
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(lifecycle.tone)}`}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-(length:--ds-font-size-ui-xs) font-bold">
                      {project.name}
                    </span>
                    <span
                      className={`rounded-[2px] border px-1 py-0.5 font-mono text-(length:--ds-font-size-ui-2xs) font-bold uppercase tracking-[0.08em] ${badgeClass(lifecycle.tone)}`}
                    >
                      {lifecycle.label}
                    </span>
                  </div>

                  {supervisorOwned || showStart || action?.error ? (
                    <div className="border-b border-border/70 px-2.5 py-2 font-mono">
                      {supervisorOwned || showStart ? (
                        <button
                          type="button"
                          disabled={action?.pending === true}
                          onClick={() =>
                            supervisorOwned
                              ? onStop(project.id)
                              : onStart(project.id)
                          }
                          className="rounded-[2px] border border-border bg-card px-2 py-1 text-(length:--ds-font-size-ui-2xs) font-bold uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground disabled:opacity-50"
                        >
                          {action?.pending
                            ? action.kind === "start"
                              ? "Starting…"
                              : "Stopping…"
                            : supervisorOwned
                              ? "Stop"
                              : "Start"}
                        </button>
                      ) : null}
                      {action?.error ? (
                        <p className="mt-1.5 text-(length:--ds-font-size-ui-2xs) leading-4 text-destructive">
                          {action.error}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {project.managed.state === "failed"
                  || project.managed.state === "exited" ? (
                    <ProjectLogsDisclosure
                      projectId={project.id}
                      exitCode={project.managed.exitCode}
                    />
                  ) : null}

                  <div className="grid grid-cols-2 gap-px bg-border/60">
                    {(["agents", "traces"] as const).map((item) => {
                      const active = selected && section === item;
                      return (
                        <button
                          key={item}
                          type="button"
                          aria-current={active ? "page" : undefined}
                          onClick={() => onSelect(project.id, item)}
                          className={`bg-card px-2.5 py-2 text-left font-mono text-(length:--ds-font-size-ui-2xs) font-bold uppercase tracking-[0.1em] transition-colors ${
                            active
                              ? "text-status-info"
                              : "text-muted-foreground hover:bg-muted/35 hover:text-foreground"
                          }`}
                        >
                          {item}
                        </button>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      <footer className="flex items-center justify-between border-t border-border px-4 py-3">
        <span className="font-mono text-(length:--ds-font-size-ui-2xs) uppercase tracking-[0.12em] text-muted-foreground">
          API :4890
        </span>
        <button
          type="button"
          onClick={onToggleTheme}
          className="flex h-(--ds-control-height-lg) items-center rounded-[2px] border border-border px-2 font-mono text-(length:--ds-font-size-ui-2xs) font-bold uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"
        >
          {theme === "dark" ? "Light" : "Dark"}
        </button>
      </footer>
    </aside>
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
      className="border-b border-border/70 bg-destructive/5 px-2.5 py-2 font-mono"
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
      <summary className="cursor-pointer text-(length:--ds-font-size-ui-2xs) font-bold uppercase tracking-[0.08em] text-destructive">
        Logs{exitCode !== undefined ? ` · exit ${exitCode}` : ""}
      </summary>
      {state.status === "loading" ? (
        <p className="mt-2 text-(length:--ds-font-size-ui-2xs) text-muted-foreground">Loading…</p>
      ) : state.status === "error" ? (
        <p className="mt-2 text-(length:--ds-font-size-ui-2xs) leading-4 text-destructive">
          {state.message}
        </p>
      ) : state.status === "ready" ? (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-[2px] border border-border bg-background p-2 text-(length:--ds-font-size-ui-2xs) leading-4 text-muted-foreground">
          {state.lines.length > 0 ? state.lines.join("\n") : "No output captured."}
        </pre>
      ) : null}
    </details>
  );
}

function dotClass(tone: ProjectLifecycleTone): string {
  if (tone === "success") {
    return "bg-status-success shadow-[0_0_4px_rgb(84_214_147/0.45)]";
  }
  if (tone === "warning") return "bg-status-warning";
  if (tone === "destructive") return "bg-destructive";
  return "bg-muted-foreground/40";
}

function badgeClass(tone: ProjectLifecycleTone): string {
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
