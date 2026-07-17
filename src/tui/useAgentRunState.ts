import { useEffect, useState } from "react";
import type { JsonlSessionMetadata, Session } from "@earendil-works/pi-agent-core/node";
import type { AgentRunRuntime } from "../agents/runtime.js";

export interface AgentRunState {
  queued: number;
  running: number;
}

/** Project the platform-neutral AgentRun event source into compact TUI counts. */
export function useAgentRunState(
  runtime: AgentRunRuntime | undefined,
  session: Session<JsonlSessionMetadata>,
): AgentRunState {
  const [state, setState] = useState<AgentRunState>({ queued: 0, running: 0 });

  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      if (!runtime) {
        if (!cancelled) setState({ queued: 0, running: 0 });
        return;
      }
      const metadata = await session.getMetadata();
      const runs = await runtime.manager.list({
        parentSessionId: metadata.id,
        generation: metadata.id,
      });
      if (cancelled) return;
      setState({
        queued: runs.filter((run) => run.status === "queued").length,
        running: runs.filter((run) => run.status === "starting" || run.status === "running").length,
      });
    };
    void refresh();
    const unsubscribe = runtime?.manager.events.subscribe(() => void refresh());
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [runtime, session]);

  return state;
}
