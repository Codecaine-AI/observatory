import { existsSync } from "node:fs";

import {
  defaultPath,
  openActionLog,
  type Query,
  type StoredRecord,
} from "@codecaine-ai/action-log";

export interface ActionsResponse {
  /** The action-log file this response read. */
  path: string;
  records: StoredRecord[];
}

/** The URL query parameters GET /api/actions accepts, mapped to action-log filters. */
const FILTER_PARAMS = {
  thread: "threadId",
  target: "target",
  run: "runId",
  since: "since",
  until: "until",
} as const satisfies Record<string, keyof Query>;

/**
 * Reads the machine's action log. A missing file means no MCP server has
 * written yet: the read returns no records and creates nothing, so Observatory
 * never becomes a writer. `CODECAINE_ACTION_LOG` is read per call.
 */
export function readActions(params: URLSearchParams): ActionsResponse {
  const path = defaultPath();
  const filter: Query = {};
  for (const [param, key] of Object.entries(FILTER_PARAMS)) {
    const value = params.get(param);
    if (value) filter[key] = value;
  }
  const limit = params.get("limit");
  if (limit) filter.limit = Number(limit);

  if (!existsSync(path)) return { path, records: [] };
  const log = openActionLog({ path });
  try {
    return { path, records: log.query(filter) };
  } finally {
    log.close();
  }
}
