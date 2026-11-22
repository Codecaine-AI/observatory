import { describe, expect, test } from "bun:test";

import { ClickHouseBusyError } from "@codecaine-ai/agent-kernel-viewer-read-service";

import { limitConcurrency } from "../src/server/query-limit";

describe("the ClickHouse query queue", () => {
  test("runs at most 2 queries at a time, holds each slot until its body is read, and answers every one", async () => {
    let running = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    const limited = limitConcurrency(async (input) => {
      running++;
      most = Math.max(most, running);
      // The body streams until the test releases it, as a long ClickHouse answer does.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          releases.push(() => {
            controller.enqueue(new TextEncoder().encode(String(input)));
            controller.close();
            running--;
          });
        },
      });
      return new Response(body, { status: 200 });
    }, 2);

    const answers = Promise.all(["a", "b", "c", "d", "e"].map((name) => limited(name).then((response) => response.text())));
    // Each released body frees a slot for the next query in the queue.
    for (let round = 0; round < 5; round++) {
      await Bun.sleep(5);
      releases.shift()?.();
    }

    expect(await answers).toEqual(["a", "b", "c", "d", "e"]);
    expect(most).toBe(2);
  });

  test("gives a freed slot to the waiting query, not to a query that arrives at the same moment", async () => {
    let running = 0;
    let most = 0;
    const finish = new Map<string, () => void>();
    const limited = limitConcurrency(async (input) => {
      running++;
      most = Math.max(most, running);
      const body = new Promise<ArrayBuffer>((resolve) =>
        finish.set(String(input), () => {
          running--;
          resolve(new ArrayBuffer(0));
        }),
      );
      return { status: 200, statusText: "OK", headers: new Headers(), arrayBuffer: () => body } as unknown as Response;
    }, 1);

    const first = limited("first");
    const waiting = limited("waiting");
    await Bun.sleep(1);
    // The new query arrives after the first query ends and before the waiting query wakes.
    finish.get("first")!();
    let late: Promise<Response> | undefined;
    queueMicrotask(() => (late = limited("late")));
    await first;
    await Bun.sleep(1);

    expect([...finish.keys()]).toEqual(["first", "waiting"]);
    finish.get("waiting")!();
    await waiting;
    await Bun.sleep(1);
    finish.get("late")!();
    await late;
    expect(most).toBe(1);
  });

  test("drops an aborted waiting query from the queue, and runs the others in order", async () => {
    const started: string[] = [];
    const finish = new Map<string, () => void>();
    const limited = limitConcurrency(async (input) => {
      started.push(String(input));
      const body = new Promise<ArrayBuffer>((resolve) => finish.set(String(input), () => resolve(new ArrayBuffer(0))));
      return { status: 200, statusText: "OK", headers: new Headers(), arrayBuffer: () => body } as unknown as Response;
    }, 1);

    const cancel = new AbortController();
    const first = limited("first");
    const second = limited("second");
    const aborted = limited("aborted", { signal: cancel.signal });
    const last = limited("last");
    await Bun.sleep(1);
    cancel.abort(new Error("the page closed"));
    await expect(aborted).rejects.toThrow("the page closed");

    for (const name of ["first", "second", "last"]) {
      await Bun.sleep(1);
      finish.get(name)!();
    }
    await Promise.all([first, second, last]);
    expect(started).toEqual(["first", "second", "last"]);
  });

  test("takes the signal of a Request input unless the init sets a signal, even null", async () => {
    const finish: (() => void)[] = [];
    const limited = limitConcurrency(async () => {
      const body = new Promise<ArrayBuffer>((resolve) => finish.push(() => resolve(new ArrayBuffer(0))));
      return { status: 200, statusText: "OK", headers: new Headers(), arrayBuffer: () => body } as unknown as Response;
    }, 1);
    const cancelled = new AbortController();
    cancelled.abort(new Error("cancelled"));
    const request = new Request("http://clickhouse.test/", { signal: cancelled.signal });

    const first = limited("first");
    await expect(limited(request)).rejects.toThrow("cancelled");
    const overridden = limited(request, { signal: null });
    await Bun.sleep(1);
    finish.shift()!();
    await first;
    await Bun.sleep(1);
    finish.shift()!();
    expect((await overridden).status).toBe(200);
  });

  test("refuses a query at once when the queue is full, and takes new ones when it drains", async () => {
    const finish: (() => void)[] = [];
    const limited = limitConcurrency(
      async () => {
        const body = new Promise<ArrayBuffer>((resolve) => finish.push(() => resolve(new ArrayBuffer(0))));
        return { status: 200, statusText: "OK", headers: new Headers(), arrayBuffer: () => body } as unknown as Response;
      },
      1,
      { maxWaiting: 2 },
    );
    const held = [limited("running"), limited("waiting 1"), limited("waiting 2")];
    const refused = limited("one too many");
    await expect(refused).rejects.toBeInstanceOf(ClickHouseBusyError);
    await expect(refused).rejects.toThrow("2 trace store queries wait already");
    for (let round = 0; round < 3; round++) {
      await Bun.sleep(1);
      finish.shift()!();
    }
    await Promise.all(held);
    const after = limited("after");
    await Bun.sleep(1);
    finish.shift()!();
    expect((await after).status).toBe(200);
  });

  test("stops a running query when its signal aborts, and frees its slot for the next", async () => {
    const started: string[] = [];
    const limited = limitConcurrency(async (input, init) => {
      started.push(String(input));
      const signal = init?.signal;
      const body = new Promise<ArrayBuffer>((resolve, reject) => {
        // A real fetch rejects its body read when its signal aborts, which cancels the ClickHouse query.
        signal?.addEventListener("abort", () => reject(signal.reason));
        if (String(input) === "next") resolve(new ArrayBuffer(0));
      });
      return { status: 200, statusText: "OK", headers: new Headers(), arrayBuffer: () => body } as unknown as Response;
    }, 1);
    const request = new AbortController();
    const running = limited("running", { signal: request.signal });
    const next = limited("next");
    await Bun.sleep(1);
    request.abort(new Error("the request ended"));
    await expect(running).rejects.toThrow("the request ended");
    expect((await next).status).toBe(200);
    expect(started).toEqual(["running", "next"]);
  });

  test("frees the slot of a query that fails", async () => {
    const limited = limitConcurrency(async (input) => {
      if (String(input) === "bad") throw new Error("network down");
      return new Response("ok", { status: 500 });
    }, 1);

    await expect(limited("bad")).rejects.toThrow("network down");
    const response = await limited("next");
    expect([response.status, await response.text()]).toEqual([500, "ok"]);
  });
});
