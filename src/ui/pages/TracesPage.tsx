import { useEffect, useMemo, useState } from "react";
import {
  buildTraceSpans,
  type KernelTraceSessionDetail,
  type KernelTraceSessionSummary,
} from "@codecaine-ai/agent-kernel-viewer-core";
import {
  KernelTraceWorkspace,
  type TraceWorkspaceRow,
} from "@codecaine-ai/agent-kernel-viewer-shell";

import {
  fetchTraceSessionDetail,
  fetchTraceSessions,
  viewerApiPrefix,
  type RegistryProject,
} from "../api";
import { useProjectDetailBlockProvider } from "../extensions";

interface TracesPageProps {
  project: RegistryProject;
}

type SessionState =
  | { status: "loading"; sessions: KernelTraceSessionSummary[] }
  | { status: "ready"; sessions: KernelTraceSessionSummary[] }
  | { status: "error"; sessions: KernelTraceSessionSummary[]; message: string };

type DetailState =
  | { status: "idle"; detail: null }
  | { status: "loading"; detail: null }
  | { status: "ready"; detail: KernelTraceSessionDetail }
  | { status: "error"; detail: null; message: string };

export function TracesPage({ project }: TracesPageProps) {
  const [sessionState, setSessionState] = useState<SessionState>({
    status: "loading",
    sessions: [],
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<DetailState>({
    status: "idle",
    detail: null,
  });
  const detailBlockProvider = useProjectDetailBlockProvider(project);

  useEffect(() => {
    const controller = new AbortController();
    setSessionState({ status: "loading", sessions: [] });
    setSelectedId(null);
    setDetailState({ status: "idle", detail: null });

    void fetchTraceSessions(project.id, controller.signal)
      .then((body) => {
        if (!Array.isArray(body.trace_sessions)) {
          throw new Error("Trace API returned an invalid session list.");
        }
        // No auto-select: landing on All Traces shows the list at rest and
        // the empty detail state until the human picks a trace.
        setSessionState({ status: "ready", sessions: body.trace_sessions });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setSessionState({
          status: "error",
          sessions: [],
          message: errorMessage(cause, "Trace sessions unavailable."),
        });
      });

    return () => controller.abort();
  }, [project.id]);

  useEffect(() => {
    if (!selectedId) {
      setDetailState({ status: "idle", detail: null });
      return;
    }
    const controller = new AbortController();
    setDetailState({ status: "loading", detail: null });
    void fetchTraceSessionDetail(project.id, selectedId, controller.signal)
      .then((detail) => setDetailState({ status: "ready", detail }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setDetailState({
          status: "error",
          detail: null,
          message: errorMessage(cause, "Trace detail unavailable."),
        });
      });
    return () => controller.abort();
  }, [project.id, selectedId]);

  const sessions = sessionState.sessions;
  const detail = detailState.status === "ready" ? detailState.detail : null;

  const spans = useMemo(
    () =>
      detail
        ? buildTraceSpans(
            detail.events,
            detail.pi_sessions,
            detail.agent_runs,
            detail.containers ?? (detail.container ? [detail.container] : []),
          )
        : [],
    [detail],
  );

  const rows = useMemo<TraceWorkspaceRow[]>(
    () =>
      sessions.map((session) => ({
        id: session.id,
        title: session.topic ?? session.label ?? session.id,
        subtitle: traceSubtitle(session),
        status: session.status,
      })),
    [sessions],
  );

  const selectedSession = useMemo(
    () =>
      sessions.find(
        (session) =>
          session.id === selectedId ||
          session.containerId === selectedId ||
          (detail !== null &&
            (session.id === detail.session.id ||
              session.containerId === detail.session.containerId)),
      ) ?? null,
    [detail, selectedId, sessions],
  );

  const workspaceDetail = useMemo(
    () =>
      detail
        ? {
            id: detail.session.id,
            title:
              selectedSession?.topic ??
              selectedSession?.label ??
              detail.session.label ??
              detail.session.id,
            status: selectedSession?.status ?? detail.session.status ?? "unknown",
            subtitle: selectedSession ? traceSubtitle(selectedSession) : null,
          }
        : null,
    [detail, selectedSession],
  );

  const usageData = useMemo(
    () =>
      detail
        ? {
            container: detail.container ?? null,
            runs: detail.agent_runs,
            sessions: detail.pi_sessions,
          }
        : undefined,
    [detail],
  );

  const errorMessageText =
    sessionState.status === "error"
      ? sessionState.message
      : detailState.status === "error"
        ? detailState.message
        : null;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {errorMessageText ? (
        <div className="mb-3 shrink-0 rounded-[3px] border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[11px] text-destructive">
          {errorMessageText}
        </div>
      ) : null}
      {!project.live ? (
        <div className="mb-3 shrink-0 rounded-[3px] border border-status-neutral-border bg-status-neutral-fill px-3 py-2 font-mono text-[10px] text-status-neutral">
          Harness not running. Showing traces from the local SQLite database.
        </div>
      ) : null}
      {project.tracesAvailable === false ? (
        <div className="mb-3 shrink-0 rounded-[3px] border border-border bg-card px-3 py-2 font-mono text-[10px] text-muted-foreground">
          No traces yet. The project has not created its trace database.
        </div>
      ) : null}
      <KernelTraceWorkspace
        key={project.id}
        rows={rows}
        selectedRowId={selectedSession?.id ?? selectedId}
        detail={workspaceDetail}
        spans={spans}
        loading={
          sessionState.status === "loading" ||
          detailState.status === "loading"
        }
        onSelect={setSelectedId}
        usageData={usageData}
        apiBase={viewerApiPrefix(project.id)}
        labels={{
          listTitle: `${project.name} traces`,
          countNoun: "session",
          rowColumnLabel: "Session",
        }}
        detailBlockProvider={detailBlockProvider}
      />
    </div>
  );
}

function traceSubtitle(session: KernelTraceSessionSummary): string {
  const pieces = [
    `${session.piSessionCount} pi`,
    `${session.eventCount} events`,
    session.updatedAt ?? session.createdAt,
  ];
  return pieces.filter(Boolean).join(" · ");
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
