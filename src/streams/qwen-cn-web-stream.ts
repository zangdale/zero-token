import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@mariozechner/pi-ai";
import {
  QwenCNWebClientBrowser,
  type QwenCNWebClientOptions,
} from "../providers/qwen-cn-web-client-browser.js";
import { stripInboundMeta } from "./strip-inbound-meta.js";

/** 按 OpenAI 请求体 `user` 隔离；未传时共用 `default`，保证千问侧同一 `session_id` 与可解析时的 `parent_req` 多轮。 */
type QwenCNBrowserSession = {
  sessionId: string;
  lastParentReqId: string;
  /** 本键下已跑过至少一次完整流式，后续优先走多轮/continue（视是否有 parent 而定） */
  hadResponse: boolean;
};

const qwenCNBrowserSessionByKey = new Map<string, QwenCNBrowserSession>();

function newQwenSessionId(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

function deepFindSessionId(data: unknown, d = 0): string | undefined {
  if (d > 14) return;
  if (!data || typeof data !== "object") return;
  const o = data as Record<string, unknown>;
  for (const k of ["sessionId", "session_id", "session", "sessionid"]) {
    const v = o[k];
    if (typeof v === "string" && v.length > 4) return v;
  }
  for (const v of Object.values(o)) {
    if (v && typeof v === "object") {
      const r = deepFindSessionId(v, d + 1);
      if (r) return r;
    }
  }
  return;
}

function deepFindReqId(data: unknown, d = 0): string | undefined {
  if (d > 16) return;
  if (!data) return;
  if (Array.isArray(data)) {
    for (let i = data.length - 1; i >= 0; i--) {
      const r = deepFindReqId(data[i], d + 1);
      if (r) return r;
    }
    return;
  }
  if (typeof data !== "object") return;
  const o = data as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "string" && (k === "req_id" || k === "reqId" || (k === "id" && v.startsWith("req-")))) {
      if (v !== "0" && v.length) return v;
    }
  }
  for (const v of Object.values(o)) {
    if (v && typeof v === "object") {
      const r = deepFindReqId(v, d + 1);
      if (r) return r;
    }
  }
  return;
}

function patchSessionFromSseData(st: QwenCNBrowserSession, data: unknown) {
  const sid = deepFindSessionId(data) ?? (data && typeof data === "object" && "data" in (data as object) ? deepFindSessionId((data as { data: unknown }).data) : undefined);
  if (typeof sid === "string" && sid.length > 4) {
    st.sessionId = sid;
  }
  const pr = deepFindReqId(data) ?? (data && typeof data === "object" && "data" in (data as object) ? deepFindReqId((data as { data: unknown }).data) : undefined);
  if (typeof pr === "string" && pr && pr !== "0") {
    st.lastParentReqId = pr;
  }
}

export function createQwenCNWebStreamFn(cookieOrJson: string): StreamFn {
  let options: QwenCNWebClientOptions;
  try {
    const parsed = JSON.parse(cookieOrJson);
    options = parsed;
  } catch {
    options = { cookie: cookieOrJson, xsrfToken: "" };
  }
  const client = new QwenCNWebClientBrowser(options);

  return (model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        await client.init();

        const ext = context as Context & { user?: string; sessionId?: string };
        const sessionKey = ext.user?.trim() || ext.sessionId || "default";

        if (!qwenCNBrowserSessionByKey.has(sessionKey)) {
          qwenCNBrowserSessionByKey.set(sessionKey, {
            sessionId: newQwenSessionId(),
            lastParentReqId: "0",
            hadResponse: false,
          });
        }
        const st = qwenCNBrowserSessionByKey.get(sessionKey)!;

        const messages = context.messages || [];

        // Qwen CN web uses DOM simulation — only send the last user message.
        // System prompts, tools, and full history would overwhelm the input.
        let prompt = "";
        const lastUserMessage = [...messages].toReversed().find((m) => m.role === "user");
        if (lastUserMessage) {
          if (typeof lastUserMessage.content === "string") {
            prompt = lastUserMessage.content;
          } else if (Array.isArray(lastUserMessage.content)) {
            prompt = (lastUserMessage.content as TextContent[])
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
          }
        }

        prompt = stripInboundMeta(prompt);
        if (!prompt) {
          throw new Error("No message found to send to Qwen API");
        }

        const isContinue =
          st.hadResponse && st.lastParentReqId && st.lastParentReqId !== "0";

        console.log(`[QwenCNWebStream] sessionKey=${sessionKey} qwenSessionId=${st.sessionId.slice(0, 8)}... continue=${isContinue} parentReq=${st.lastParentReqId}`);
        console.log(`[QwenCNWebStream] Prompt length: ${prompt.length}`);

        const responseStream = await client.chatCompletions({
          sessionId: st.sessionId,
          parentMessageId: isContinue ? st.lastParentReqId : undefined,
          message: prompt,
          model: model.id,
          signal: streamOptions?.signal,
        });

        if (!responseStream) {
          throw new Error("Qwen API returned empty response body");
        }

        const reader = responseStream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let rawSseAccum = "";

        const indexMap = new Map<string, number>();
        let nextIndex = 0;
        const contentParts: (TextContent | ThinkingContent | ToolCall)[] = [];
        const accumulatedToolCalls: {
          id: string;
          name: string;
          arguments: string;
          index: number;
        }[] = [];

        const createPartial = (): AssistantMessage => {
          const msg: AssistantMessage = {
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
            stopReason: accumulatedToolCalls.length > 0 ? "toolUse" : "stop",
            timestamp: Date.now(),
          };
          (msg as AssistantMessage & { thinking_enabled?: boolean }).thinking_enabled =
            contentParts.some((p) => p.type === "thinking");
          return msg;
        };

        let currentMode: "text" | "thinking" | "tool_call" = "text";
        let currentToolName = "";
        let currentToolIndex = 0;
        let tagBuffer = "";

        const emitDelta = (
          type: "text" | "thinking" | "toolcall",
          delta: string,
          forceId?: string,
        ) => {
          if (delta === "" && type !== "toolcall") {
            return;
          }
          const key = type === "toolcall" ? `tool_${currentToolIndex}` : type;

          if (!indexMap.has(key)) {
            const index = nextIndex++;
            indexMap.set(key, index);
            if (type === "text") {
              contentParts[index] = { type: "text", text: "" };
              stream.push({ type: "text_start", contentIndex: index, partial: createPartial() });
            } else if (type === "thinking") {
              contentParts[index] = { type: "thinking", thinking: "" };
              stream.push({
                type: "thinking_start",
                contentIndex: index,
                partial: createPartial(),
              });
            } else if (type === "toolcall") {
              const toolId = forceId || `call_${Date.now()}_${index}`;
              contentParts[index] = {
                type: "toolCall",
                id: toolId,
                name: currentToolName,
                arguments: {},
              };
              accumulatedToolCalls[currentToolIndex] = {
                id: toolId,
                name: currentToolName,
                arguments: "",
                index: currentToolIndex,
              };
              stream.push({
                type: "toolcall_start",
                contentIndex: index,
                partial: createPartial(),
              });
            }
          }

          const index = indexMap.get(key)!;
          if (type === "text") {
            (contentParts[index] as TextContent).text += delta;
            stream.push({
              type: "text_delta",
              contentIndex: index,
              delta,
              partial: createPartial(),
            });
          } else if (type === "thinking") {
            (contentParts[index] as ThinkingContent).thinking += delta;
            stream.push({
              type: "thinking_delta",
              contentIndex: index,
              delta,
              partial: createPartial(),
            });
          } else if (type === "toolcall") {
            accumulatedToolCalls[currentToolIndex].arguments += delta;
            stream.push({
              type: "toolcall_delta",
              contentIndex: index,
              delta,
              partial: createPartial(),
            });
          }
        };

        const pushDelta = (delta: string, forceType?: "text" | "thinking") => {
          if (!delta) {
            return;
          }
          if (forceType === "thinking") {
            emitDelta("thinking", delta);
            return;
          }
          tagBuffer += delta;

          const checkTags = () => {
            const thinkStart = tagBuffer.match(/<think\b[^<>]*>/i);
            const thinkEnd = tagBuffer.match(/<\/think\b[^<>]*>/i);
            const toolCallStart = tagBuffer.match(
              /<tool_call\s*(?:id=['"]?([^'"]+)['"]?\s*)?name=['"]?([^'"]+)['"]?\s*>/i,
            );
            const toolCallEnd = tagBuffer.match(/<\/tool_call\s*>/i);

            const indices = [
              {
                type: "think_start",
                idx: thinkStart?.index ?? -1,
                len: thinkStart?.[0].length ?? 0,
              },
              { type: "think_end", idx: thinkEnd?.index ?? -1, len: thinkEnd?.[0].length ?? 0 },
              {
                type: "tool_start",
                idx: toolCallStart?.index ?? -1,
                len: toolCallStart?.[0].length ?? 0,
                id: toolCallStart?.[1],
                name: toolCallStart?.[2],
              },
              {
                type: "tool_end",
                idx: toolCallEnd?.index ?? -1,
                len: toolCallEnd?.[0].length ?? 0,
              },
            ]
              .filter((t) => t.idx !== -1)
              .toSorted((a, b) => a.idx - b.idx);

            if (indices.length > 0) {
              const first = indices[0];
              const before = tagBuffer.slice(0, first.idx);
              if (before) {
                if (currentMode === "thinking") {
                  emitDelta("thinking", before);
                } else if (currentMode === "tool_call") {
                  emitDelta("toolcall", before);
                } else {
                  emitDelta("text", before);
                }
              }

              if (first.type === "think_start") {
                currentMode = "thinking";
              } else if (first.type === "think_end") {
                currentMode = "text";
              } else if (first.type === "tool_start") {
                currentMode = "tool_call";
                currentToolName = first.name!;
                emitDelta("toolcall", "", first.id);
              } else if (first.type === "tool_end") {
                const index = indexMap.get(`tool_${currentToolIndex}`);
                if (index !== undefined) {
                  const part = contentParts[index] as ToolCall;
                  const argStr = accumulatedToolCalls[currentToolIndex].arguments || "{}";

                  let cleanedArg = argStr.trim();
                  if (cleanedArg.startsWith("```json")) {
                    cleanedArg = cleanedArg.substring(7);
                  } else if (cleanedArg.startsWith("```")) {
                    cleanedArg = cleanedArg.substring(3);
                  }
                  if (cleanedArg.endsWith("```")) {
                    cleanedArg = cleanedArg.substring(0, cleanedArg.length - 3);
                  }
                  cleanedArg = cleanedArg.trim();

                  try {
                    part.arguments = JSON.parse(cleanedArg);
                  } catch (e) {
                    part.arguments = { raw: argStr };
                    console.error(
                      `[Qwen Stream] Failed to parse JSON for tool call ${currentToolName}:`,
                      argStr,
                      "\nError:",
                      e,
                    );
                  }
                  stream.push({
                    type: "toolcall_end",
                    contentIndex: index,
                    toolCall: part,
                    partial: createPartial(),
                  });
                }
                currentMode = "text";
                currentToolIndex++;
              }
              tagBuffer = tagBuffer.slice(first.idx + first.len);
              checkTags();
            } else {
              const lastAngle = tagBuffer.lastIndexOf("<");
              if (lastAngle === -1) {
                const mode =
                  currentMode === "thinking"
                    ? "thinking"
                    : currentMode === "tool_call"
                      ? "toolcall"
                      : "text";
                emitDelta(mode, tagBuffer);
                tagBuffer = "";
              } else if (lastAngle > 0) {
                const safe = tagBuffer.slice(0, lastAngle);
                const mode =
                  currentMode === "thinking"
                    ? "thinking"
                    : currentMode === "tool_call"
                      ? "toolcall"
                      : "text";
                emitDelta(mode, safe);
                tagBuffer = tagBuffer.slice(lastAngle);
              }
            }
          };
          checkTags();
        };

        let lastExtractedContent = "";
        const processLine = (line: string) => {
          if (!line) {
            return;
          }

          // Parse SSE format: event: xxx\ndata: yyy
          // Current line could be event: or data:
          if (line.startsWith("event:")) {
            return;
          }

          if (!line.startsWith("data:")) {
            return;
          }

          const dataStr = line.slice(5).trim();
          if (dataStr === "[DONE]" || !dataStr) {
            return;
          }

          try {
            const data = JSON.parse(dataStr);
            patchSessionFromSseData(st, data);

            // Extract content delta - Qwen v2 uses choices[0].delta.content
            // Qwen CN Web returns different structure
            console.log(
              `[QwenCNWebStream] Debug data.data: ${JSON.stringify(data.data)?.substring(0, 200)}`,
            );
            console.log(
              `[QwenCNWebStream] Debug data.communication: ${JSON.stringify(data.communication)?.substring(0, 200)}`,
            );

            let delta = "";
            // Qwen CN Web specific extraction
            if (data.data?.messages && Array.isArray(data.data.messages)) {
              // Find the last message with content field (likely assistant response)
              for (let i = data.data.messages.length - 1; i >= 0; i--) {
                const msg = data.data.messages[i];
                if (msg.content && typeof msg.content === "string") {
                  delta = msg.content;
                  console.log(
                    `[QwenCNWebStream] Extracted content from messages[${i}], length: ${delta.length}`,
                  );
                  break;
                }
              }
            }

            // Fallback to other fields if no content found in messages
            if (!delta) {
              delta = data.choices?.[0]?.delta?.content;
              if (!delta && data.data) {
                delta = data.data.text ?? data.data.content ?? data.data.delta;
              }
              if (!delta && data.communication) {
                delta = data.communication.text ?? data.communication.content;
              }
              if (!delta) {
                delta = data.text ?? data.content ?? data.delta;
              }
            }
            if (typeof delta === "string" && delta) {
              // Qwen CN sends accumulated content (not incremental deltas).
              // Only emit the new portion to avoid repetition.
              if (
                delta.length > lastExtractedContent.length &&
                delta.startsWith(lastExtractedContent)
              ) {
                const newPart = delta.slice(lastExtractedContent.length);
                lastExtractedContent = delta;
                if (newPart) {
                  pushDelta(newPart);
                }
              } else if (delta !== lastExtractedContent) {
                // Completely different content — emit as-is (new message)
                lastExtractedContent = delta;
                pushDelta(delta);
              }
            }
          } catch {
            // Ignore parse errors
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
          rawSseAccum += chunk;
          const combined = buffer + chunk;
          const parts = combined.split("\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            processLine(part.trim());
          }
        }

        if (rawSseAccum.length > 0) {
          for (const line of rawSseAccum.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;
            try {
              patchSessionFromSseData(st, JSON.parse(raw) as unknown);
            } catch {
              // ignore
            }
          }
        }
        st.hadResponse = true;

        // Flush remaining tag buffer
        if (tagBuffer) {
          const mode =
            (currentMode as string) === "thinking"
              ? "thinking"
              : (currentMode as string) === "tool_call"
                ? "toolcall"
                : "text";
          emitDelta(mode, tagBuffer);
        }

        console.log(
          `[QwenCNWebStream] Stream completed. Parts: ${contentParts.length}, Tools: ${accumulatedToolCalls.length}`,
        );

        stream.push({
          type: "done",
          reason: accumulatedToolCalls.length > 0 ? "toolUse" : "stop",
          message: createPartial(),
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage,
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
