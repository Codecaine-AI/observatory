/**
 * The trace ClickHouse lets the read-only user run 2 queries at a time, and
 * answers error 202 (TOO_MANY_SIMULTANEOUS_QUERIES) to a third. The Work page
 * alone reads 5 at once (the Sessions, 2 for the orphans, 2 for the source
 * ages), so the API queues its queries and sends at most `max` at a time.
 * The read service still retries an error 202 that another client causes.
 */

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The most ClickHouse queries that one API process runs at a time: the limit of the traces_ro user. */
export const MAX_CLICKHOUSE_QUERIES = 2;

/**
 * A fetch that runs at most `max` requests at a time, in the order they came.
 * A request keeps its slot until its body is read, because ClickHouse counts
 * a query as running while it streams the answer.
 */
export function limitConcurrency(fetchImpl: Fetch, max: number): Fetch {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (input, init) => {
    // A waiter gets the slot of the request that ends, so no new caller can take it in between.
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
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
