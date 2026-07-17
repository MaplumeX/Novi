import { describe, expect, it } from "vitest";
import { AgentRunQueue } from "./queue.js";

describe("AgentRunQueue", () => {
  it("keeps FIFO order while skipping temporarily blocked runs", () => {
    const queue = new AgentRunQueue();
    expect(queue.enqueue("one")).toBe(true);
    expect(queue.enqueue("two")).toBe(true);
    expect(queue.enqueue("one")).toBe(false);
    expect(queue.takeFirst((id) => id !== "one")).toBe("two");
    expect(queue.snapshot()).toEqual(["one"]);
    expect(queue.takeFirst(() => true)).toBe("one");
    expect(queue.size).toBe(0);
  });
});
