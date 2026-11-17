import { useEffect, useMemo, useRef, useState } from "react";
import {
  reviveEngineRun,
  type EngineRunListResponse,
} from "@codecaine-ai/agent-kernel-viewer-read-service/wire";
import {
  KernelTraceWorkspace,
  type TraceWorkspaceRow,
} from "@codecaine-ai/agent-kernel-viewer-shell";

import {
  ARCHON_HOME_KERNEL_PREFIX,
  ENGINE_RUNS_API_PREFIX,
  fetchEngineRun,
  fetchEngineRuns,
} from "../api";

export interface EngineRunRef {
  engine: string;
  runId: string;
}

interface RunsPageProps {
  /** The open run, from the route; null shows the list. */
  run: EngineRunRef | null;
  onOpen: (run: EngineRunRef | null) => void;
}

type ListState =
  | { status: "loading"; runs: EngineRunSummary[] }
  | { status: "ready"; runs: EngineRunSummary[] }
  | { status: "error"; runs: EngineRunSummary[]; message: string };

type RunState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; run: EngineRunSummary; spans: TraceSpan[] }
  | { status: "error"; message: string };

type EngineRunSummary = EngineRunListResponse["engine_runs"][number];
type TraceSpan = ReturnType<typeof reviveEngineRun>["spans"][number];

/** How often the list and the open run are read again. */
const REFRESH_MS = 30_000;

const rowId = (run: EngineRunRef): string => `${run.engine}/${run.runId}`;

/**
 * The engine runs of the Archon home, newest first, and one run as a tree
 * with the detail panel: the same workspace as the kernel Traces page.
 */
export function RunsPage({ run, onOpen }: RunsPageProps) {
  const [listState, setListState] = useState<ListState>({ status: "loading", runs: [] });
  const [runState, setRunState] = useState<RunState>({ status: "idle" });
  // A run keeps changing after it starts: its status, and gateway rows that
  // arrive minutes after their calls. Both reads repeat quietly.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const interval = window.setInterval(() => setTick((value) => value + 1), REFRESH_MS);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const quiet = tick > 0;
    void fetchEngineRuns(controller.signal)
      .then((body) => {
        if (!Array.isArray(body.engine_runs)) {
          throw new Error("The engine run API returned an invalid run list.");
        }
        setListState({ status: "ready", runs: body.engine_runs });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const message = errorMessage(cause, "Engine runs unavailable.");
        // A failed re-read keeps the last list on screen.
        setListState((current) => ({ status: "error", runs: quiet ? current.runs : [], message }));
      });
    return () => controller.abort();
  }, [tick]);

  const engine = run?.engine ?? null;
  const runId = run?.runId ?? null;
  /** The run whose tree is on screen, so a re-read of it does not blank the tree. */
  const shownRun = useRef<string | null>(null);
  useEffect(() => {
    if (!engine || !runId) {
      shownRun.current = null;
      setRunState({ status: "idle" });
      return;
    }
    const key = rowId({ engine, runId });
    const quiet = shownRun.current === key;
    const controller = new AbortController();
    if (!quiet) setRunState({ status: "loading" });
    void fetchEngineRun(engine, runId, controller.signal)
      .then((body) => {
        const revived = reviveEngineRun(body);
        shownRun.current = key;
        setRunState({ status: "ready", run: revived.run, spans: revived.spans });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || quiet) return;
        setRunState({ status: "error", message: errorMessage(cause, "Engine run unavailable.") });
      });
    return () => controller.abort();
  }, [engine, runId, tick]);

  const rows = useMemo<TraceWorkspaceRow[]>(
    () =>
      listState.runs.map((summary) => ({
        id: rowId(summary),
        title: summary.workflowName ?? summary.runId,
        subtitle: runSubtitle(summary),
        status: summary.status ?? "unknown",
        badge: summary.engine,
      })),
    [listState.runs],
  );

  const detail =
    runState.status === "ready"
      ? {
          id: rowId(runState.run),
          title: runState.run.workflowName ?? runState.run.runId,
          status: runState.run.status ?? "unknown",
          subtitle: runSubtitle(runState.run),
        }
      : null;

  const errorText =
    listState.status === "error"
      ? listState.message
      : runState.status === "error"
        ? runState.message
        : null;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {errorText ? (
        <div className="mb-3 shrink-0 rounded-[var(--ds-radius-base)] border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-(length:--ds-font-size-ui-xs) text-destructive">
          {errorText}
        </div>
      ) : null}
      <KernelTraceWorkspace
        rows={rows}
        selectedRowId={run ? rowId(run) : null}
        detail={detail}
        spans={runState.status === "ready" ? runState.spans : []}
        loading={listState.status === "loading" || runState.status === "loading"}
        onSelect={(id) => {
          const summary = listState.runs.find((candidate) => rowId(candidate) === id);
          if (summary) onOpen({ engine: summary.engine, runId: summary.runId });
        }}
        onBack={() => onOpen(null)}
        apiBase={ARCHON_HOME_KERNEL_PREFIX}
        engineApiBase={ENGINE_RUNS_API_PREFIX}
        labels={{
          listTitle: "Engine runs",
          countNoun: "run",
          rowColumnLabel: "Run",
          backLabel: "All runs",
          emptyList: "No engine runs found.",
          loadingTrace: "Loading engine run...",
        }}
      />
    </div>
  );
}

/** `run c5993f42 · 2026-11-17 11:53:37`: the short run id and the local start time. */
export function runSubtitle(run: EngineRunSummary): string {
  const pieces = [`run ${run.runId.slice(0, 8)}`];
  if (run.startedAt) pieces.push(formatLocalTime(run.startedAt));
  return pieces.join(" · ");
}

function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
