import { existsSync } from "node:fs";

import {
  listSessionContainersWithStats,
  openKernelDatabaseReadOnly,
  type KernelDatabaseHandle,
} from "@agent-kernel/db";
import {
  createContainerReadService,
  type KernelReadApiService,
  type KernelSessionContainerSummary,
} from "@agent-kernel/kernel";
import type { KernelTraceReadQuery } from "@agent-kernel/kernel/read-api";

import type { ResolvedRegistryProject } from "./registry";

/**
 * Container kinds surfaced in the observatory session list.
 *
 * The kernel's standard read service already returns kind "session" (which
 * includes TUI-originated sessions — they carry `metadata.origin: "tui"`).
 * Every OTHER kind listed here gets its own stats query and is merged into
 * the same list. To surface a new container kind, add it here rather than
 * editing the merge logic below.
 */
const SESSION_CONTAINER_KINDS: readonly string[] = ["session", "layout-session"];

const EXTRA_SESSION_CONTAINER_KINDS = SESSION_CONTAINER_KINDS.filter(
  (kind) => kind !== "session",
);

export class ProjectDatabaseManager {
  readonly #handles = new Map<string, KernelDatabaseHandle>();
  readonly #services = new Map<string, KernelReadApiService>();

  getService(project: ResolvedRegistryProject): KernelReadApiService | null {
    const cached = this.#services.get(project.id);
    if (cached) return cached;

    let handle = this.#handles.get(project.id);
    if (!handle) {
      if (!existsSync(project.dbPath)) return null;
      handle = openKernelDatabaseReadOnly(project.dbPath);
      this.#handles.set(project.id, handle);
    }
    const standard = createContainerReadService({ db: handle.db });
    const service: KernelReadApiService = {
      ...standard,
      async listSessionContainers(query: KernelTraceReadQuery = {}) {
        const [sessionList, ...extraKindRows] = await Promise.all([
          standard.listSessionContainers(query),
          ...EXTRA_SESSION_CONTAINER_KINDS.map((kind) =>
            listSessionContainersWithStats(handle.db, {
              kind,
              limit: query.limit ?? 100,
            }),
          ),
        ]);
        const extraSessions = extraKindRows.flat().map(
          ({
            container,
            piSessionCount,
            eventCount,
            latestEventAt,
          }): KernelSessionContainerSummary => {
            const metadata =
              (container.metadata as Record<string, unknown> | null) ?? {};
            const topic =
              metadataString(metadata, "topic")
              ?? metadataString(metadata, "instruction")
              ?? container.label
              ?? null;
            return {
              id: container.id,
              containerId: container.id,
              kind: container.kind,
              label: container.label ?? container.id,
              topic,
              status: container.status,
              phase: container.phase ?? null,
              createdAt: container.createdAt,
              updatedAt:
                latestEventAt
                ?? container.endedAt
                ?? container.startedAt
                ?? container.createdAt,
              piSessionCount,
              eventCount,
              latestEventAt,
              metadata,
            };
          },
        );
        const limit = Math.max(1, Math.min(query.limit ?? 100, 500));
        return {
          trace_sessions: [
            ...sessionList.trace_sessions,
            ...extraSessions,
          ]
            .sort((a, b) =>
              (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
            )
            .slice(0, limit),
        };
      },
    };
    this.#services.set(project.id, service);
    return service;
  }

  hasDatabase(project: ResolvedRegistryProject): boolean {
    return existsSync(project.dbPath);
  }

  close(): void {
    for (const handle of this.#handles.values()) {
      handle.close();
    }
    this.#handles.clear();
    this.#services.clear();
  }
}

function metadataString(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
