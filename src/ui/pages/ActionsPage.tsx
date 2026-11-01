import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { fetchActions, type ActionFilter, type ActionRecord } from "../api";

type ActionsState =
  | { status: "loading" }
  | { status: "ready"; path: string; records: ActionRecord[] }
  | { status: "error"; message: string };

const COLUMNS = ["Time", "Thread", "Agent", "Tool", "Target", "Result"] as const;

/** The action log's default query limit (`QUERY_LIMIT`). The UI cannot import it: the package needs bun:sqlite. */
const READ_CAP = 1000;

const inputClass =
  "h-(--ds-control-height-lg) min-w-0 flex-1 rounded-[2px] border border-border bg-background px-2 font-mono text-(length:--ds-font-size-ui-xs) text-foreground placeholder:text-muted-foreground";
const buttonClass =
  "flex h-(--ds-control-height-lg) items-center rounded-[2px] border border-border bg-card px-3 font-mono text-(length:--ds-font-size-ui-2xs) font-bold uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground";

/** Every MCP tool call on this machine, from the shared action log, newest first. */
export function ActionsPage() {
  const [draft, setDraft] = useState<ActionFilter>({});
  const [filter, setFilter] = useState<ActionFilter>({});
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<ActionsState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void fetchActions(filter, controller.signal)
      .then(({ path, records }) =>
        setState({ status: "ready", path, records: [...records].reverse() }),
      )
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: cause instanceof Error ? cause.message : "Action log unavailable.",
        });
      });
    return () => controller.abort();
  }, [filter, reload]);

  const apply = (next: ActionFilter) => {
    const trimmed = { thread: next.thread?.trim(), target: next.target?.trim() };
    setDraft(trimmed);
    setFilter(trimmed);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    apply(draft);
  };

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[3px] border border-border bg-card">
      <form
        onSubmit={onSubmit}
        className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2"
      >
        <input
          aria-label="Thread id"
          placeholder="Thread id"
          value={draft.thread ?? ""}
          onChange={(event) => setDraft({ ...draft, thread: event.target.value })}
          className={inputClass}
        />
        <input
          aria-label="Target"
          placeholder="Target, such as canvases/payments-flow"
          value={draft.target ?? ""}
          onChange={(event) => setDraft({ ...draft, target: event.target.value })}
          className={inputClass}
        />
        <button type="submit" className={buttonClass}>
          Filter
        </button>
        <button type="button" className={buttonClass} onClick={() => apply({})}>
          Clear
        </button>
        <button type="button" className={buttonClass} onClick={() => setReload((n) => n + 1)}>
          Refresh
        </button>
      </form>

      {state.status === "loading" ? (
        <PanelMessage>Reading the action log…</PanelMessage>
      ) : state.status === "error" ? (
        <PanelMessage tone="error">{state.message}</PanelMessage>
      ) : state.records.length === 0 ? (
        <PanelMessage>No actions match. Source: {state.path}</PanelMessage>
      ) : (
        <>
          <div
            tabIndex={0}
            className="observatory-scroll-region min-h-0 flex-1 overflow-auto"
          >
            <table className="w-full border-collapse font-mono text-(length:--ds-font-size-ui-xs)">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b border-border text-left">
                  {COLUMNS.map((column) => (
                    <th
                      key={column}
                      className="px-3 py-2 text-(length:--ds-font-size-ui-2xs) font-bold uppercase tracking-[0.1em] text-muted-foreground"
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.records.map((record) => (
                  <tr key={record.id} className="border-b border-border/60 align-top">
                    <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">
                      <time dateTime={record.at} title={record.at}>
                        {new Date(record.at).toLocaleString()}
                      </time>
                    </td>
                    <td className="max-w-48 truncate px-3 py-1.5">
                      {record.threadId ? (
                        <FilterLink
                          label={record.threadId}
                          onClick={() => apply({ ...filter, thread: record.threadId ?? "" })}
                        />
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5">{record.agent}</td>
                    <td className="whitespace-nowrap px-3 py-1.5">{record.tool}</td>
                    <td className="max-w-64 truncate px-3 py-1.5">
                      <FilterLink
                        label={record.target}
                        onClick={() => apply({ ...filter, target: record.target })}
                      />
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">{record.result}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <footer className="shrink-0 border-t border-border px-3 py-1.5 font-mono text-(length:--ds-font-size-ui-2xs) text-muted-foreground">
            {state.records.length} actions · {state.path}
            {state.records.length >= READ_CAP
              ? ` · capped at the oldest ${READ_CAP}. Filter to narrow.`
              : null}
          </footer>
        </>
      )}
    </section>
  );
}

function FilterLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={`Filter by ${label}`}
      onClick={onClick}
      className="max-w-full truncate text-left hover:text-status-info hover:underline"
    >
      {label}
    </button>
  );
}

function PanelMessage({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-6 font-mono">
      <p
        className={`text-(length:--ds-font-size-ui-xs) ${tone === "error" ? "text-destructive" : "text-muted-foreground"}`}
      >
        {children}
      </p>
    </div>
  );
}
