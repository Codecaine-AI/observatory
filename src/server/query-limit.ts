/**
 * The trace ClickHouse lets the read-only user run 2 queries at a time, and
 * answers error 202 (TOO_MANY_SIMULTANEOUS_QUERIES) to a third. The Work page
 * alone reads 5 at once (the Sessions, 2 for the orphans, 2 for the source
 * ages), so the API queues its queries and sends at most `max` at a time.
 * The read service still retries an error 202 that another client causes.
 *
 * A query carries the signal of the HTTP request that asked for it (the read
 * service joins it with its timeout). When the request ends early, a waiting
 * query leaves the queue at once, and a running one stops: an aborted HTTP
 * request to ClickHouse cancels its query there. The queue holds at most
 * `MAX_WAITING_QUERIES`; one more fails at once with ClickHouseBusyError,
 * which the routes answer as 503 with its message.
 */
import { ClickHouseBusyError } from "@codecaine-ai/agent-kernel-viewer-read-service";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The most ClickHouse queries that one API process runs at a time: the limit of the traces_ro user. */
export const MAX_CLICKHOUSE_QUERIES = 2;
/** The most queries that wait for a slot: at about 0.3 s a query, the last one waits about 10 s. */
export const MAX_WAITING_QUERIES = 64;

/**
 * A fetch that runs at most `max` requests at a time, in the order they came,
 * with at most `maxWaiting` in the queue. A request keeps its slot until its
 * body is read, because ClickHouse counts a query as running while it
 * streams the answer.
 */
export function limitConcurrency(fetchImpl: Fetch, max: number, { maxWaiting = MAX_WAITING_QUERIES }: { maxWaiting?: number } = {}): Fetch {
  let active = 0;
  const waiting: (() => void)[] = [];
  // Resolves when a request that ends hands its slot over. An aborted request leaves the queue
  // and rejects with the reason of its signal. It holds no slot, so it frees none.
  const waitForSlot = (signal: AbortSignal | undefined) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const onAbort = () => {
        waiting.splice(waiting.indexOf(wake), 1);
        reject(signal!.reason);
      };
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      waiting.push(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  return async (input, init) => {
    // A waiter gets the slot of the request that ends, so no new caller can take it in between.
    // As in fetch, an init signal, even null, overrides the signal of a Request input.
    const signal = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : null;
    if (active >= max) {
      if (waiting.length >= maxWaiting) {
        throw new ClickHouseBusyError(`${maxWaiting} trace store queries wait already; try again in a moment`);
      }
      await waitForSlot(signal ?? undefined);
    } else active++;
    try {
      const response = await fetchImpl(input, init);
      const body = await response.arrayBuffer();
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
