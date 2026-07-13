import type {
  AgentHarness,
  JsonlSessionMetadata,
  Session,
} from "@earendil-works/pi-agent-core/node";
import type { GatewayEnv, CreatedSession } from "../../bootstrap.js";
import { createHarnessForSession } from "../../bootstrap.js";
import { createEventBridge } from "./event-bridge.js";
import type {
  AgentProtocolAdapter,
  AgentProtocolTurnInput,
  AgentProtocolTurnResult,
} from "../core/types.js";
import type { ToolCatalogSnapshot } from "../../tools/contracts.js";

/** Cached harness + session for one session key. */
interface SessionEntry {
  harness: AgentHarness;
  session: Session<JsonlSessionMetadata>;
  sessionPath: string;
  toolCatalog: ToolCatalogSnapshot;
}

/**
 * In-process `AgentProtocolAdapter` wrapping `AgentHarness`.
 *
 * Each session key (`channelId:chatId`) gets a lazily-created, independent
 * `AgentHarness` + `JsonlSession` reusing the one-time {@link GatewayEnv}
 * preparation. Turns are run via `harness.prompt()`; steer/followUp/abort
 * are forwarded to the harness public API (callable mid-turn).
 *
 * This is the MVP in-process implementation of the
 * {@link AgentProtocolAdapter} boundary. A future `RemoteAgentAdapter` can
 * replace it without touching the orchestrator (design.md §8).
 */
export class NoviAgentAdapter implements AgentProtocolAdapter {
  private readonly gatewayEnv: GatewayEnv;
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(gatewayEnv: GatewayEnv) {
    this.gatewayEnv = gatewayEnv;
  }

  /** Get or lazily create the harness+session for a session key. */
  private async getOrCreateHarness(sessionKey: string): Promise<SessionEntry> {
    let entry = this.sessions.get(sessionKey);
    if (entry) return entry;

    const created: CreatedSession = await createHarnessForSession(this.gatewayEnv, sessionKey);
    entry = {
      harness: created.harness,
      session: created.session,
      sessionPath: created.sessionPath,
      toolCatalog: created.toolCatalog,
    };
    this.sessions.set(sessionKey, entry);
    return entry;
  }

  /** {@inheritDoc AgentProtocolAdapter.runTurn} */
  async runTurn(input: AgentProtocolTurnInput): Promise<AgentProtocolTurnResult> {
    const { sessionKey, text, callbacks } = input;
    const entry = await this.getOrCreateHarness(sessionKey);
    const { harness } = entry;

    let finalText = "";
    const bridgedCallbacks = callbacks
      ? {
          ...callbacks,
          onTurnEnd: (text: string): Promise<void> => {
            finalText = text;
            return callbacks.onTurnEnd?.(text) ?? Promise.resolve();
          },
        }
      : undefined;

    const unsubscribe = callbacks
      ? createEventBridge(harness, bridgedCallbacks!, entry.toolCatalog)
      : null;

    try {
      // session-lane guarantees phase==="idle" before calling runTurn.
      await harness.prompt(text);
    } finally {
      unsubscribe?.();
    }

    return { text: finalText };
  }

  /** {@inheritDoc AgentProtocolAdapter.steer} */
  async steer(sessionKey: string, text: string): Promise<void> {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return;
    await entry.harness.steer(text);
  }

  /** {@inheritDoc AgentProtocolAdapter.followUp} */
  async followUp(sessionKey: string, text: string): Promise<void> {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return;
    await entry.harness.followUp(text);
  }

  /** {@inheritDoc AgentProtocolAdapter.abort} */
  async abort(sessionKey: string): Promise<void> {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return;
    await entry.harness.abort();
  }

  /** {@inheritDoc AgentProtocolAdapter.resetSession} */
  async resetSession(sessionKey: string): Promise<void> {
    await this.closeSession(sessionKey);
  }

  /** {@inheritDoc AgentProtocolAdapter.closeSession} */
  async closeSession(sessionKey: string): Promise<void> {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return;
    try {
      await entry.harness.waitForIdle();
    } catch (e) {
      // Best-effort: even if waitForIdle throws, still drop the cache so the
      // next getOrCreate rebuilds a fresh harness.
      process.stderr.write(
        `warning: closeSession("${sessionKey}"): waitForIdle failed: ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
    }
    this.sessions.delete(sessionKey);
  }

  /** {@inheritDoc AgentProtocolAdapter.stop} */
  async stop(): Promise<void> {
    const keys = [...this.sessions.keys()];
    await Promise.allSettled(keys.map((key) => this.closeSession(key)));
  }
}
