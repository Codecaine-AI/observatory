import { useEffect, useMemo, useState } from "react";
import {
  type CatalogAgentDetail,
  type CatalogAgentSummary,
} from "@agent-kernel/viewer-core";
import {
  AgentPromptLabContainer,
  PromptStyleSidebar,
  PROMPT_STYLE_SIDEBAR_DEFAULT_WIDTH,
  clampPromptStyleSidebarWidth,
} from "@agent-kernel/viewer-ui";
import { usePromptStyleSettings } from "@codecaine-ai/prompt-kit/ui/style";

import {
  fetchCatalogAgentDetail,
  viewerApiPrefix,
  type RegistryProject,
} from "../api";

interface AgentPageProps {
  project: RegistryProject;
  /** Selected in the sidebar tree; the page renders exactly this agent. */
  agent: CatalogAgentSummary;
}

export function AgentPage({ project, agent }: AgentPageProps) {
  const {
    settings: styleSettings,
    update: updateStyleSettings,
    reset: resetStyleSettings,
  } = usePromptStyleSettings();
  const [styleOpen, setStyleOpen] = useState(false);
  const [styleWidth, setStyleWidth] = useState(
    PROMPT_STYLE_SIDEBAR_DEFAULT_WIDTH,
  );

  if (!project.live) {
    return (
      <UnavailablePanel
        title="Agents unavailable"
        message="Harness not running. Traces remain available from the local database."
      />
    );
  }

  return (
    <section className="flex h-full min-h-[560px] gap-3 font-mono">
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
            key={`${project.id}:${agent.name}`}
            baseUrl={viewerApiPrefix(project.id)}
            agentName={agent.name}
            className="h-full"
            styleSettings={styleSettings}
          />
        ) : (
          <ReadOnlyAgentDetail
            key={`${project.id}:${agent.name}`}
            projectId={project.id}
            agent={agent}
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
