import type { GatewayRuntimeSnapshot, GatewayRuntimeState } from "./snapshot.js";

export interface StoppedGatewaySnapshot {
  version: 1;
  state: "stopped";
  health: { live: false; ready: false };
  reason: string;
}

export type GatewayStatusView = GatewayRuntimeSnapshot | StoppedGatewaySnapshot;

export function stoppedGatewaySnapshot(
  reason = "control socket is unavailable",
): StoppedGatewaySnapshot {
  return { version: 1, state: "stopped", health: { live: false, ready: false }, reason };
}

export function formatGatewayStatus(snapshot: GatewayStatusView): string {
  if (snapshot.state === "stopped") {
    return `state: stopped\nlive: no\nready: no\nreason: ${snapshot.reason}\n`;
  }
  const channels = snapshot.channels
    .map((channel) => `  ${channel.id} (${channel.type}): ${channel.state}`)
    .join("\n");
  const messages = snapshot.messages
    ? `messages: ${snapshot.messages.nonTerminalRecords} active, ${snapshot.messages.terminalRecords} terminal\n`
    : "";
  const scheduler = snapshot.scheduler
    ? `scheduler: ${snapshot.scheduler.enabled} enabled, ${snapshot.scheduler.queuedOrRunning} active, ${snapshot.scheduler.pendingDelivery} pending delivery\n`
    : "scheduler: unavailable\n";
  const agentRuns = snapshot.agentRuns
    ? `agents: ${snapshot.agentRuns.running} running, ${snapshot.agentRuns.queued} queued, ${snapshot.agentRuns.interrupted} interrupted, ${snapshot.agentRuns.pendingCompletion} pending completion\n`
    : "";
  const reasons = snapshot.degradedReasons.length
    ? `reasons: ${snapshot.degradedReasons.join(", ")}\n`
    : "";
  return `state: ${snapshot.state}\nlive: yes\nready: ${snapshot.health.ready ? "yes" : "no"}\npid: ${snapshot.pid}\nuptimeSince: ${snapshot.startedAt}\nchannels: ${snapshot.channels.length}\n${channels}${channels ? "\n" : ""}activeSessions: ${snapshot.sessions.activeSessions}\n${messages}${scheduler}${agentRuns}${reasons}`;
}

export function gatewayStatusExitCode(state: GatewayRuntimeState | "stopped"): number {
  if (state === "ready") return 0;
  if (state === "degraded") return 2;
  return 1;
}
