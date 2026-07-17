import type { AgentRunEvent } from "./types.js";

export type AgentRunEventListener = (event: AgentRunEvent) => void;

/** Process-local event source; the durable store remains authoritative. */
export class AgentRunEventBus {
  private readonly listeners = new Set<AgentRunEventListener>();

  subscribe(listener: AgentRunEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentRunEvent): void {
    for (const listener of this.listeners) listener(structuredClone(event));
  }
}
