/** Stable FIFO queue that may skip temporarily blocked items (for example a cwd write lease). */
export class AgentRunQueue {
  private readonly ids: string[] = [];
  private readonly present = new Set<string>();

  enqueue(runId: string): boolean {
    if (this.present.has(runId)) return false;
    this.present.add(runId);
    this.ids.push(runId);
    return true;
  }

  remove(runId: string): boolean {
    if (!this.present.delete(runId)) return false;
    const index = this.ids.indexOf(runId);
    if (index >= 0) this.ids.splice(index, 1);
    return true;
  }

  takeFirst(predicate: (runId: string) => boolean): string | undefined {
    const index = this.ids.findIndex(predicate);
    if (index < 0) return undefined;
    const [runId] = this.ids.splice(index, 1);
    if (runId) this.present.delete(runId);
    return runId;
  }

  has(runId: string): boolean {
    return this.present.has(runId);
  }

  snapshot(): string[] {
    return [...this.ids];
  }

  get size(): number {
    return this.ids.length;
  }
}
