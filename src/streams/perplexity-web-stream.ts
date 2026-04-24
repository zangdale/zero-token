import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type TextContent,
  type ToolCall,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";
import {
  PerplexityWebClientBrowser,
  type PerplexityWebClientOptions,
} from "../providers/perplexity-web-client-browser.js";
import { stripInboundMeta } from "./strip-inbound-meta.js";

export function createPerplexityWebStreamFn(cookieOrJson: string): StreamFn {
  let options: PerplexityWebClientOptions;
  try {
    const parsed = JSON.parse(cookieOrJson);
    options = typeof parsed === "string" ? { cookie: parsed, userAgent: "Mozilla/5.0" } : parsed;
  } catch {
    options = { cookie: cookieOrJson, userAgent: "Mozilla/5.0" };
  }
  const client = new PerplexityWebClientBrowser(options);

  return (model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        await client.init();

        const messages = context.messages || [];
        const systemPrompt = (context as unknown as { systemPrompt?: string }).systemPrompt || "";

        const historyParts: string[] = [];
        if (systemPrompt && !messages.some((m) => (m.role as string) === "system")) {
          historyParts.push(`System: ${systemPrompt}`);
        }
        for (const m of messages) {
          const role = m.role === "user" || m.role === "toolResult" ? "User" : "Assistant";
          let content = "";
          if (m.role === "toolResult") {
            const tr = m as unknown as ToolResultMessage;
            let resultText = "";
            if (Array.isArray(tr.content)) {
              for (const part of tr.content) {
                if (part.type === "text") {
                  resultText += part.text;
                }
              }
            }
            content = `\n[Tool Result: ${tr.toolName}]\n${resultText}\n`;
          } else if (Array.isArray(m.content)) {
            for (const part of m.content) {
              if (part.type === "text") {
                content += part.text;
              }
            }
          } else {
            content = String(m.content);
          }
          if (m.role === "user" && content) {
            content = stripInboundMeta(content) || content;
          }
          historyParts.push(`${role}: ${content}`);
        }

        // Perplexity is a search engine, not a chat model.
        // Only send the last user message to avoid overwhelming it with system prompts.
        let prompt = "";
        const lastUserMsg = [...messages].toReversed().find((m) => m.role === "user");
        if (lastUserMsg) {
          if (typeof lastUserMsg.content === "string") {
            prompt = stripInboundMeta(lastUserMsg.content) || lastUserMsg.content;
          } else if (Array.isArray(lastUserMsg.content)) {
            prompt = (lastUserMsg.content as Array<{ type: string; text?: string }>)
              .filter((p) => p.type === "text")
              .map((p) => p.text || "")
              .join("");
            prompt = stripInboundMeta(prompt) || prompt;
          }
        }
        if (!prompt) {
          // Fallback to full history if no user message found
          prompt = historyParts.join("\n\n");
        }
        if (!prompt) {
          throw new Error("No message found to send to Perplexity API");
        }

        console.log(`[PerplexityWebStream] Starting run`);

        const responseStream = await client.chatCompletions({
          message: prompt,
          model: model.id,
          signal: streamOptions?.signal,
        });

        if (!responseStream) {
          throw new Error("Perplexity API returned empty response body");
        }

        const reader = responseStream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const contentParts: (TextContent | ToolCall)[] = [];

        const createPartial = (): AssistantMessage => ({
          role: "assistant",
          content: [...contentParts],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        });

        const processLine = (line: string) => {
          if (!line || !line.startsWith("data:")) {
            return;
          }
          const dataStr = line.slice(5).trim();
          if (dataStr === "[DONE]" || !dataStr) {
            return;
          }
          try {
            const data = JSON.parse(dataStr);
            const delta = data.text || data.content || data.delta;
            if (typeof delta === "string" && delta) {
              if (contentParts.length === 0) {
                contentParts[0] = { type: "text", text: "" };
                stream.push({ type: "text_start", contentIndex: 0, partial: createPartial() });
              }
              (contentParts[0] as TextContent).text += delta;
              stream.push({ type: "text_delta", contentIndex: 0, delta, partial: createPartial() });
            }
          } catch {
            // ignore
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer.trim()) {
              processLine(buffer.trim());
            }
            break;
          }
          const chunk = decoder.decode(value, { stream: true });
          const combined = buffer + chunk;
          const parts = combined.split("\n");
          buffer = parts.pop() || "";
          for (const part of parts) {
            processLine(part.trim());
          }
        }

        const assistantMessage: AssistantMessage = {
          role: "assistant",
          content: contentParts.length > 0 ? contentParts : [{ type: "text", text: "" }],
          stopReason: "stop",
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: Date.now(),
        };

        stream.push({ type: "done", reason: "stop", message: assistantMessage });
      } catch (err) {
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: err instanceof Error ? err.message : String(err),
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        } as unknown as Parameters<typeof stream.push>[0]);
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}
