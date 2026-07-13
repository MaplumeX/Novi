import { PassThrough } from "node:stream";
import { render } from "ink";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core/node";
import {
  fauxAssistantMessage,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MessageList } from "./MessageList.js";

const toolCatalog = { descriptors: [], activeToolNames: [], availability: [], diagnostics: [] };

const mounted: Array<{ unmount: () => void }> = [];

afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
});

async function renderTranscript(messages: AgentMessage[], detailed = false): Promise<string> {
  const stdout = new PassThrough() as PassThrough & { columns: number; isTTY: boolean };
  stdout.columns = 100;
  stdout.isTTY = true;
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const instance = render(
    <MessageList
      messages={messages}
      phase="idle"
      streamingText=""
      streamingThinking=""
      streamingThinkingActive={false}
      streamingToolCalls={[]}
      toolCatalog={toolCatalog}
      detailed={detailed}
    />,
    { stdout: stdout as unknown as NodeJS.WriteStream, exitOnCtrlC: false },
  );
  mounted.push(instance);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return output;
}

describe("TUI transcript hierarchy", () => {
  it("renders compact user, thought, semantic tool action, and result", async () => {
    const toolCall = fauxToolCall(
      "edit_file",
      {
        path: "src/a.ts",
        edits: [{ oldText: "one", newText: "one\ntwo" }],
      },
      { id: "call-1" },
    );
    const messages: AgentMessage[] = [
      { role: "user", content: "Update the file", timestamp: 1 },
      fauxAssistantMessage([fauxThinking("Inspecting the current file"), toolCall]),
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "edit_file",
        content: [{ type: "text", text: "updated" }],
        isError: false,
        timestamp: 2,
      },
    ];

    const output = await renderTranscript(messages);
    expect(output).toContain("Update the file");
    expect(output).toContain("Thought — Inspecting the current file");
    expect(output).toContain("Update src/a.ts");
    expect(output).toContain("Updated +1 -0");
    expect(output).not.toContain("oldText");
  });

  it("reveals raw thinking and tool detail in detailed mode", async () => {
    const toolCall = fauxToolCall("bash", { command: "printf hello" }, { id: "call-2" });
    const messages: AgentMessage[] = [
      fauxAssistantMessage([fauxThinking("first line\nsecond line"), toolCall]),
      {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "bash",
        content: [{ type: "text", text: "exit 0\nhello" }],
        isError: false,
        timestamp: 2,
      },
    ];

    const output = await renderTranscript(messages, true);
    expect(output).toContain("│ first line");
    expect(output).toContain("│ second line");
    expect(output).toContain("$ printf hello");
    expect(output).toContain("exit 0");
  });
});
