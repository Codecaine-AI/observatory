import { existsSync } from "node:fs";

import {
  listSessionContainersWithStats,
  openKernelDatabaseReadOnly,
  type KernelDatabaseHandle,
} from "@codecaine-ai/agent-kernel-db";
import {
  createContainerReadService,
  type KernelReadApiService,
  type KernelSessionContainerSummary,
} from "@codecaine-ai/agent-kernel";
import type { KernelTraceReadQuery } from "@codecaine-ai/agent-kernel/read-api";

import type { ResolvedRegistryProject } from "./registry";

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
        const [sessionList, layoutRows] = await Promise.all([
          standard.listSessionContainers(query),
          listSessionContainersWithStats(handle.db, {
            kind: "layout-session",
            limit: query.limit ?? 100,
          }),
        ]);
        const layoutSessions = layoutRows.map(
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
            ...layoutSessions,
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
