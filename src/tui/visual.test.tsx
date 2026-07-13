import { PassThrough } from "node:stream";
import { render } from "ink";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core/node";
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MessageList } from "./MessageList.js";

const toolCatalog = { descriptors: [], activeToolNames: [], availability: [], diagnostics: [] };

const mounted: Array<{ unmount: () => void }> = [];

afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
});

interface StreamingFixture {
  text?: string;
  thinking?: string;
  thinkingActive?: boolean;
}

async function renderTranscript(
  messages: AgentMessage[],
  detailed = false,
  streaming: StreamingFixture = {},
): Promise<string> {
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
      streamingText={streaming.text ?? ""}
      streamingThinking={streaming.thinking ?? ""}
      streamingThinkingActive={streaming.thinkingActive ?? false}
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

function lineStart(output: string, content: string): number {
  const index = output.indexOf(content);
  expect(index).toBeGreaterThanOrEqual(0);
  return output.lastIndexOf("\n", index - 1) + 1;
}

function markerCount(output: string): number {
  return output.split("◆").length - 1;
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
    expect(output).not.toContain("◆");
  });

  it("aligns the assistant marker with the first persisted answer", async () => {
    const messages: AgentMessage[] = [
      fauxAssistantMessage([
        fauxThinking("Inspecting the request"),
        fauxText("Final answer"),
        fauxToolCall("bash", { command: "printf done" }, { id: "call-3" }),
        fauxText("Follow-up text"),
      ]),
      {
        role: "toolResult",
        toolCallId: "call-3",
        toolName: "bash",
        content: [{ type: "text", text: "done" }],
        isError: false,
        timestamp: 2,
      },
    ];

    const output = await renderTranscript(messages);
    expect(lineStart(output, "◆")).toBe(lineStart(output, "Final answer"));
    expect(lineStart(output, "◆")).not.toBe(lineStart(output, "⠿ Thought"));
    expect(markerCount(output)).toBe(1);
    expect(output.indexOf("Inspecting the request")).toBeLessThan(output.indexOf("Final answer"));
    expect(output.indexOf("Final answer")).toBeLessThan(output.indexOf("Run printf done"));
    expect(output.indexOf("Run printf done")).toBeLessThan(output.indexOf("Follow-up text"));
  });

  it("hides the marker during streaming thought and shows it with streaming text", async () => {
    const thinkingOnly = await renderTranscript([], false, {
      thinking: "Inspecting the request",
      thinkingActive: true,
    });
    expect(thinkingOnly).not.toContain("◆");

    const withAnswer = await renderTranscript([], false, {
      text: "Streaming answer",
      thinking: "Inspecting the request",
    });
    expect(lineStart(withAnswer, "◆")).toBe(lineStart(withAnswer, "Streaming answer"));
    expect(lineStart(withAnswer, "◆")).not.toBe(lineStart(withAnswer, "⠿ Thought"));
    expect(markerCount(withAnswer)).toBe(1);
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
