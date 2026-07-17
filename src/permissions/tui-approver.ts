import type { ApprovalChoice, ApprovalRequest, Approver } from "./types.js";

/** Snapshot of the currently displayed permission prompt (for React state). */
export interface PermissionPromptState {
  toolName: string;
  toolCallId: string;
  summary: string;
  capability: ApprovalRequest["capability"];
  target: string;
  scope: ApprovalRequest["scope"];
  reason: string;
  shellBoundaryWarning: boolean;
  sessionGrantAvailable: boolean;
  source?: ApprovalRequest["source"];
}

type Listener = (prompt: PermissionPromptState | null) => void;

interface QueueItem {
  req: ApprovalRequest;
  resolve: (choice: ApprovalChoice) => void;
}

/**
 * TUI Approver: queues concurrent ask requests and exposes the active prompt
 * via subscribe() for React state. Resolves when the user picks once/session/
 * deny (or when denyAll is called on abort).
 */
export class TuiApprover implements Approver {
  private readonly queue: QueueItem[] = [];
  private active: QueueItem | null = null;
  private readonly listeners = new Set<Listener>();

  async request(req: ApprovalRequest): Promise<ApprovalChoice> {
    return new Promise<ApprovalChoice>((resolve) => {
      this.queue.push({ req, resolve });
      this.pump();
    });
  }

  /** Subscribe to the currently displayed prompt (null when idle). */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    // Immediately emit current state so late subscribers sync.
    listener(this.currentPrompt());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Current prompt for the active request, or null. */
  currentPrompt(): PermissionPromptState | null {
    if (!this.active) return null;
    return {
      toolName: this.active.req.toolName,
      toolCallId: this.active.req.toolCallId,
      summary: this.active.req.summary,
      capability: this.active.req.capability,
      target: this.active.req.target,
      scope: this.active.req.scope,
      reason: this.active.req.reason,
      shellBoundaryWarning: this.active.req.shellBoundaryWarning,
      sessionGrantAvailable: this.active.req.sessionGrantAvailable,
      ...(this.active.req.source ? { source: { ...this.active.req.source } } : {}),
    };
  }

  /** Resolve the active prompt with a user choice. */
  respond(choice: ApprovalChoice): void {
    if (!this.active) return;
    const { resolve } = this.active;
    this.active = null;
    this.emit();
    resolve(choice);
    this.pump();
  }

  /**
   * Deny all pending + active approvals (e.g. on turn abort / Ctrl-C).
   * Pending queue items are resolved as deny without showing UI.
   */
  denyAll(): void {
    if (this.active) {
      const { resolve } = this.active;
      this.active = null;
      resolve("deny");
    }
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      item.resolve("deny");
    }
    this.emit();
  }

  /** Deny only approvals owned by one child run without disturbing unrelated work. */
  denyForRun(runId: string): void {
    if (this.active?.req.source?.kind === "agent-run" && this.active.req.source.runId === runId) {
      const { resolve } = this.active;
      this.active = null;
      resolve("deny");
    }
    const retained: QueueItem[] = [];
    for (const item of this.queue) {
      if (item.req.source?.kind === "agent-run" && item.req.source.runId === runId) {
        item.resolve("deny");
      } else {
        retained.push(item);
      }
    }
    this.queue.splice(0, this.queue.length, ...retained);
    this.emit();
    this.pump();
  }

  private pump(): void {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) {
      this.emit();
      return;
    }
    this.active = next;
    this.emit();
  }

  private emit(): void {
    const prompt = this.currentPrompt();
    for (const listener of this.listeners) {
      listener(prompt);
    }
  }
}
