import { useEffect, useMemo, useState } from "react";
import {
  type CatalogAgentDetail,
  type CatalogAgentSummary,
} from "@codecaine-ai/agent-kernel-viewer-core";
import {
  AgentPromptLabContainer,
  PromptStyleSidebar,
  PROMPT_STYLE_SIDEBAR_DEFAULT_WIDTH,
  clampPromptStyleSidebarWidth,
} from "@codecaine-ai/agent-kernel-viewer-ui";
import { usePromptStyleSettings } from "@codecaine-ai/prompt-kit/ui/style";

import {
  fetchCatalogAgentDetail,
  fetchCatalogAgents,
  viewerApiPrefix,
  type RegistryProject,
} from "../api";

interface AgentsPageProps {
  project: RegistryProject;
}

type CatalogState =
  | { status: "loading" }
  | { status: "ready"; agents: CatalogAgentSummary[] }
  | { status: "error"; message: string };

export function AgentsPage({ project }: AgentsPageProps) {
  const [state, setState] = useState<CatalogState>({ status: "loading" });
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const {
    settings: styleSettings,
    update: updateStyleSettings,
    reset: resetStyleSettings,
  } = usePromptStyleSettings();
  const [styleOpen, setStyleOpen] = useState(false);
  const [styleWidth, setStyleWidth] = useState(
    PROMPT_STYLE_SIDEBAR_DEFAULT_WIDTH,
  );

  useEffect(() => {
    setSelectedName(null);
    if (!project.live) return;

    const controller = new AbortController();
    setState({ status: "loading" });
    void fetchCatalogAgents(project.id, controller.signal)
      .then((body) => {
        if (!Array.isArray(body.agents)) {
          throw new Error("Agent catalog returned an invalid agent list.");
        }
        setState({ status: "ready", agents: body.agents });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: errorMessage(cause) });
      });
    return () => controller.abort();
  }, [project.id, project.live]);

  if (!project.live) {
    return (
      <UnavailablePanel
        title="Agents unavailable"
        message="Harness not running. Traces remain available from the local database."
      />
    );
  }

  if (state.status === "loading") {
    return <PageMessage>Loading agent catalog…</PageMessage>;
  }
  if (state.status === "error") {
    return <UnavailablePanel title="Agent catalog unavailable" message={state.message} />;
  }
  if (state.agents.length === 0) {
    return <PageMessage>No agents registered by this harness.</PageMessage>;
  }

  const selectedAgent =
    state.agents.find((agent) => agent.name === selectedName) ?? state.agents[0]!;

  return (
    <section className="flex h-full min-h-[560px] gap-3 font-mono">
      <aside className="flex w-60 shrink-0 flex-col overflow-hidden rounded-[3px] border border-border bg-card">
        <header className="border-b border-border px-3 py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
            Agents
          </h2>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {state.agents.length} registered
          </p>
        </header>
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {state.agents.map((agent) => {
            const selected = agent.name === selectedAgent.name;
            return (
              <li key={agent.name}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setSelectedName(agent.name)}
                  className={`mb-1 flex w-full items-center gap-2 rounded-[2px] border px-2.5 py-2 text-left transition-colors ${
                    selected
                      ? "border-status-info-border bg-status-info-fill/30 text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-muted/35 hover:text-foreground"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      agent.valid ? "bg-status-success" : "bg-destructive"
                    }`}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-bold">{agent.name}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {agent.model || "model not set"}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <div className="relative min-w-0 flex-1 overflow-hidden rounded-[3px] border border-border bg-card">
        {project.writable && (
          <button
            type="button"
            aria-label="Toggle style sidebar"
            aria-pressed={styleOpen}
            onClick={() => setStyleOpen((open) => !open)}
            className={`absolute right-2 top-2 z-10 rounded-[2px] border px-2 py-0.5 font-mono text-[10px] lowercase tracking-[0.08em] transition-colors ${
              styleOpen
                ? "border-status-info-border text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            ◧ style
          </button>
        )}
        {project.writable ? (
          <AgentPromptLabContainer
            key={`${project.id}:${selectedAgent.name}`}
            baseUrl={viewerApiPrefix(project.id)}
            agentName={selectedAgent.name}
            className="h-full"
            styleSettings={styleSettings}
          />
        ) : (
          <ReadOnlyAgentDetail
            key={`${project.id}:${selectedAgent.name}`}
            projectId={project.id}
            agent={selectedAgent}
          />
        )}
      </div>
      {project.writable && (
        <PromptStyleSidebar
          docked
          open={styleOpen}
          width={styleWidth}
          settings={styleSettings}
          onChange={updateStyleSettings}
          onReset={resetStyleSettings}
          onClose={() => setStyleOpen(false)}
          onWidthChange={(width) =>
            setStyleWidth(clampPromptStyleSidebarWidth(width))
          }
        />
      )}
    </section>
  );
}

function ReadOnlyAgentDetail({
  projectId,
  agent,
}: {
  projectId: string;
  agent: CatalogAgentSummary;
}) {
  const [detail, setDetail] = useState<CatalogAgentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setError(null);
    void fetchCatalogAgentDetail(projectId, agent.name, controller.signal)
      .then(setDetail)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [projectId, agent.name]);

  const promptText = useMemo(() => {
    if (!detail) return "";
    if (typeof detail.rendered === "string" && detail.rendered.length > 0) {
      return detail.rendered;
    }
    return JSON.stringify(detail.prompt, null, 2);
  }, [detail]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-bold">{agent.name}</h2>
          <span className="rounded-[2px] border border-status-neutral-border bg-status-neutral-fill px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-status-neutral">
            Read only
          </span>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Editing is disabled by this project’s registry entry.
        </p>
      </header>
      {error ? (
        <PageMessage tone="error">{error}</PageMessage>
      ) : !detail ? (
        <PageMessage>Loading prompt…</PageMessage>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <dl className="mb-4 grid grid-cols-[100px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[11px]">
            <dt className="uppercase tracking-[0.08em] text-muted-foreground">Model</dt>
            <dd>{agent.model || "Not set"}</dd>
            <dt className="uppercase tracking-[0.08em] text-muted-foreground">Description</dt>
            <dd>{agent.description || "No description"}</dd>
            <dt className="uppercase tracking-[0.08em] text-muted-foreground">Prompt hash</dt>
            <dd className="truncate">{detail.promptHash}</dd>
          </dl>
          <h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
            Rendered prompt
          </h3>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-[3px] border border-border bg-background p-4 text-[12px] leading-5 text-foreground">
            {promptText}
          </pre>
        </div>
      )}
    </div>
  );
}

function UnavailablePanel({ title, message }: { title: string; message: string }) {
  return (
    <section className="flex h-full min-h-[420px] items-center justify-center rounded-[3px] border border-border bg-card p-6 font-mono">
      <div className="max-w-md text-center">
        <span
          aria-hidden
          className="mx-auto mb-3 block h-2 w-2 rounded-full bg-muted-foreground/40"
        />
        <h2 className="text-[13px] font-bold">{title}</h2>
        <p className="mt-2 text-[11px] leading-5 text-muted-foreground">{message}</p>
      </div>
    </section>
  );
}

function PageMessage({
  children,
  tone = "muted",
}: {
  children: string;
  tone?: "muted" | "error";
}) {
  return (
    <div className="flex h-full min-h-[320px] items-center justify-center p-6 font-mono">
      <p className={tone === "error" ? "text-[12px] text-destructive" : "text-[11px] text-muted-foreground"}>
        {children}
      </p>
    </div>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Agent catalog unavailable.";
}
