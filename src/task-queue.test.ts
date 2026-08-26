import { describe, expect, it } from "vitest";
import { KeyedBatchQueue, KeyedTaskQueue } from "./task-queue.js";

describe("KeyedTaskQueue", () => {
  it("serializes one conversation while allowing another to proceed", async () => {
    const queue = new KeyedTaskQueue();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const first = queue.enqueue("chat-a", async () => {
      events.push("a1-start");
      await gate;
      events.push("a1-end");
    });
    const second = queue.enqueue("chat-a", async () => { events.push("a2"); });
    await queue.enqueue("chat-b", async () => { events.push("b1"); });

    expect(events).toEqual(["a1-start", "b1"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["a1-start", "b1", "a1-end", "a2"]);
  });
});

describe("KeyedBatchQueue", () => {
  it("combines rapid messages in one chat without mixing chats", async () => {
    const batches: Array<{ key: string; items: readonly string[] }> = [];
    const queue = new KeyedBatchQueue<string>(10, async (key, items) => {
      batches.push({ key, items: [...items] });
    });

    const first = queue.push("chat-a", "first");
    const second = queue.push("chat-a", "second");
    const other = queue.push("chat-b", "other");
    await Promise.all([first, second, other]);

    expect(batches).toEqual(expect.arrayContaining([
      { key: "chat-a", items: ["first", "second"] },
      { key: "chat-b", items: ["other"] },
    ]));
    expect(batches).toHaveLength(2);
  });

  it("flushes waiting messages during shutdown", async () => {
    const batches: string[][] = [];
    const queue = new KeyedBatchQueue<string>(60_000, async (_key, items) => {
      batches.push([...items]);
    });
    const pending = queue.push("chat", "waiting");
    await queue.drain();
    await pending;
    expect(batches).toEqual([["waiting"]]);
  });
});
