import { describe, expect, test } from "bun:test";

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
