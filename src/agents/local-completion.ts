import type {
  AgentHarness,
  JsonlSessionMetadata,
  Session,
} from "@earendil-works/pi-agent-core/node";
import {
  AgentCompletionError,
  type AgentCompletionPayload,
  type AgentCompletionReceipt,
  type AgentCompletionSink,
} from "./completion.js";
import type { AgentRun, ParentSessionRef } from "./types.js";

export const INTERNAL_AGENT_COMPLETION_WAKE_PREFIX =
  "[novi-internal:agent-completion] Synthesize the persisted child-agent report for run ";

interface LocalParentTarget {
  parent: ParentSessionRef;
  harness: AgentHarness;
  session: Session<JsonlSessionMetadata>;
}

/** Serializes completion turns per local parent session and owns idempotent session injection. */
export class LocalAgentCompletionSink implements AgentCompletionSink {
  private readonly targets = new Map<string, LocalParentTarget>();
  private readonly lanes = new Map<string, Promise<unknown>>();

  bind(target: LocalParentTarget): () => void {
    const key = ownerKey(target.parent);
    this.targets.set(key, target);
    return () => {
      if (this.targets.get(key) === target) this.targets.delete(key);
    };
  }

  unbind(parent: ParentSessionRef): void {
    this.targets.delete(ownerKey(parent));
  }

  deliver(run: AgentRun, payload: AgentCompletionPayload): Promise<AgentCompletionReceipt> {
    const key = ownerKey(run.parent);
    const previous = this.lanes.get(key) ?? Promise.resolve();
    const result = previous.then(
      () => this.deliverInLane(run, payload),
      () => this.deliverInLane(run, payload),
    );
    this.lanes.set(key, result);
    return result.finally(() => {
      if (this.lanes.get(key) === result) this.lanes.delete(key);
    });
  }

  private async deliverInLane(
    run: AgentRun,
    payload: AgentCompletionPayload,
  ): Promise<AgentCompletionReceipt> {
    const target = this.targets.get(ownerKey(run.parent));
    if (!target) {
      throw new AgentCompletionError(
        "PARENT_UNAVAILABLE",
        "parent session is unavailable for agent completion",
        false,
      );
    }
    const metadata = await target.session.getMetadata();
    if (metadata.id !== run.parent.session.id || target.parent.generation !== payload.parentGeneration) {
      throw new AgentCompletionError(
        "PARENT_GENERATION_MISMATCH",
        "parent session generation changed before agent completion",
        false,
      );
    }
    const existing = (await target.session.getEntries()).find(
      (entry) =>
        entry.type === "custom_message" &&
        entry.customType === "novi.agent-completion" &&
        isCompletionDetails(entry.details, payload.idempotencyKey),
    );
    const parentEntryId =
      existing?.id ??
      (await target.session.appendCustomMessageEntry(
        "novi.agent-completion",
        payload.content,
        false,
        { runId: run.id, idempotencyKey: payload.idempotencyKey },
      ));
    await target.harness.waitForIdle();
    if (this.targets.get(ownerKey(run.parent)) !== target) {
      throw new AgentCompletionError(
        "PARENT_GENERATION_MISMATCH",
        "parent session changed while agent completion was queued",
        false,
      );
    }
    await target.harness.prompt(`${INTERNAL_AGENT_COMPLETION_WAKE_PREFIX}${run.id}.`);
    return { parentEntryId };
  }
}

export function isInternalAgentCompletionWake(text: string): boolean {
  return text.startsWith(INTERNAL_AGENT_COMPLETION_WAKE_PREFIX);
}

function ownerKey(parent: ParentSessionRef): string {
  return `${parent.session.id}\0${parent.generation}`;
}

function isCompletionDetails(value: unknown, idempotencyKey: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "idempotencyKey" in value &&
    value.idempotencyKey === idempotencyKey
  );
}
