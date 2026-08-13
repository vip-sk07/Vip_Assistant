/**
 * AGENT CORE — engine/compaction.ts
 *
 * Compresses long conversation history to stay within the model's context window.
 * Inferred from: services/compact/snipCompact.ts, snipProjection.ts,
 *                and the QueryEngine's compaction gate.
 *
 * Strategy (matches blueprint's "snip" approach):
 *  1. Keep the first N messages verbatim (they contain initial context / task).
 *  2. Summarise the middle section with a separate model call.
 *  3. Append a synthetic assistant message containing the summary.
 *  4. Append the last M messages verbatim (most recent context).
 *
 * This preserves:
 *  - The original task description
 *  - A compressed record of work done
 *  - The most recent tool calls and results
 */

import type { Message, ThinkingConfig } from "../types.js";
import { callModel } from "./modelClient.js";

export type CompactionParams = {
  model: string;
  systemPrompt: string;
  signal: AbortSignal;
  keepHeadMessages?: number;  // default 4
  keepTailMessages?: number;  // default 8
};

const DEFAULT_HEAD = 4;
const DEFAULT_TAIL = 8;

// ─────────────────────────────────────────────────────────────────────────────

export async function compactHistory(
  messages: Message[],
  params: CompactionParams,
): Promise<Message[]> {
  const head = params.keepHeadMessages ?? DEFAULT_HEAD;
  const tail = params.keepTailMessages ?? DEFAULT_TAIL;

  // Nothing to compact if the history is short
  if (messages.length <= head + tail + 2) return messages;

  const headMessages = messages.slice(0, head);
  const tailMessages = messages.slice(messages.length - tail);
  const middleMessages = messages.slice(head, messages.length - tail);

  // Build a summary of the middle section
  const summary = await summariseMessages(middleMessages, params);

  // Synthetic summary message (marked as synthetic so it's never confused with
  // real model output — mirrors blueprint's SYNTHETIC_MESSAGES pattern)
  const summaryMessage: Message = {
    role: "assistant",
    content: [
      {
        type: "text",
        text: `[Context compacted — summary of previous work]\n\n${summary}`,
      },
    ],
    metadata: {
      timestamp: Date.now(),
      synthetic: true,
    },
  };

  return [...headMessages, summaryMessage, ...tailMessages];
}

// ─── Summary generation ───────────────────────────────────────────────────────

async function summariseMessages(
  messages: Message[],
  params: CompactionParams,
): Promise<string> {
  // Flatten messages to plain text for the summary prompt
  const transcript = messages
    .map(m => {
      const roleLabel = m.role === "assistant" ? "Assistant" : "User";
      const text = m.content
        .map(b => {
          if (b.type === "text") return b.text;
          if (b.type === "tool_use") return `[Tool call: ${b.name}(${JSON.stringify(b.input)})]`;
          if (b.type === "tool_result") return `[Tool result: ${typeof b.content === "string" ? b.content.slice(0, 500) : "..."}]`;
          return "";
        })
        .filter(Boolean)
        .join("\n");
      return `${roleLabel}:\n${text}`;
    })
    .join("\n\n---\n\n");

  const summaryPrompt = `\
The following is a section of a conversation between an AI coding agent and a user.
Summarise the key information: what task was being worked on, what actions were taken,
what files were modified, what the current state is, and any important decisions made.
Be concise but preserve all information that would be needed to continue the task.

TRANSCRIPT:
${transcript}

SUMMARY:`;

  try {
    const events = callModel({
      model: params.model,
      system: "You are a concise summarizer assistant.",
      messages: [{ role: "user", content: [{ type: "text", text: summaryPrompt }] }],
      tools: [],
      thinkingConfig: { type: "disabled" },
      signal: params.signal,
    });
    
    let summary = "";
    for await (const event of events) {
      if (event.type === "content_block_delta") {
        summary += event.delta;
      }
    }
    return summary || "(summary unavailable)";
  } catch (err) {
    return "(summary unavailable — context truncated)";
  }
}
