/**
 * Web Stream Middleware — unified input/output processing for all web models.
 *
 * Input:  extract last user message → strip metadata → inject tool prompt
 * Output: parse tool calls from response → emit ToolCall events
 *
 * This middleware replaces the per-stream prompt manipulation that was
 * previously duplicated across 13 stream files.
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type TextContent,
  type ToolCall,
} from "@mariozechner/pi-ai";
import { stripInboundMeta } from "../streams/strip-inbound-meta.js";
import { extractToolCall } from "./web-tool-parser.js";
import {
  shouldInjectToolPrompt,
  getToolPrompt,
  getToolPromptForOpenAIFunctions,
} from "./web-tool-prompt.js";
import type { OpenAIFunctionToolItem, ZeroTokenContextFields } from "../gateway/openai-tool-bridge.js";

/**
 * Quick keyword check: does this message likely need tool use?
 * Only inject tool prompt when keywords suggest a tool action,
 * keeping normal chat messages short to reduce ban risk.
 */
function needsToolInjection(message: string): boolean {
  const lower = message.toLowerCase();
  const keywords = [
    // File operations
    "文件",
    "file",
    "read",
    "write",
    "创建",
    "写入",
    "读取",
    "打开",
    "保存",
    "桌面",
    "desktop",
    "目录",
    "directory",
    "folder",
    "文件夹",
    // Command execution
    "执行",
    "运行",
    "命令",
    "command",
    "run",
    "exec",
    "terminal",
    "终端",
    "shell",
    // Web operations
    "搜索",
    "search",
    "查找",
    "查询",
    "fetch",
    "抓取",
    "网页",
    "url",
    "http",
    "天气",
    "weather",
    "新闻",
    "news",
    // Message
    "发送",
    "send",
    "消息",
    "message",
    "通知",
    "notify",
    // General tool hints
    "帮我",
    "help me",
    "查看",
    "check",
    "look",
    "看看",
    "show",
    "下载",
    "download",
    "安装",
    "install",
    "更新",
    "update",
  ];
  return keywords.some((kw) => lower.includes(kw));
}

/**
 * Wrap a web stream function with tool calling middleware.
 * - Rewrites context: only sends last user message + optional tool prompt
 * - Parses response: extracts tool_call JSON → emits ToolCall events
 */
export function wrapWithToolCalling(streamFn: StreamFn, api: string): StreamFn {
  return (model, context, options) => {
    // --- Input rewriting ---
    const messages = context.messages || [];
    const lastMsg = messages[messages.length - 1];

    // Check if this is a tool result feedback (agent loop returning tool execution results)
    if (lastMsg?.role === "toolResult") {
      const tr = lastMsg as unknown as {
        toolCallId?: string;
        toolName?: string;
        content?: Array<{ type: string; text?: string }>;
      };
      let resultText = "";
      if (Array.isArray(tr.content)) {
        for (const part of tr.content) {
          if (part.type === "text" && part.text) {
            resultText += part.text;
          }
        }
      }
      // Format tool result as a user message for web models
      const feedbackPrompt = `Tool ${tr.toolName || "unknown"} returned: ${resultText}\nPlease answer the original question based on this tool result.`;

      const feedbackContext = Object.assign({}, context, {
        messages: [{ role: "user" as const, content: feedbackPrompt }],
        tools: [] as typeof context.tools,
        systemPrompt: "",
      });
      console.log(`[WebStreamMiddleware] tool result feedback, len=${feedbackPrompt.length}`);
      return streamFn(model, feedbackContext, options);
    }

    // Extract just the last user message (web models can't handle full context)
    let userMessage = "";
    const lastUserMsg = [...messages].toReversed().find((m) => m.role === "user");
    if (lastUserMsg) {
      if (typeof lastUserMsg.content === "string") {
        userMessage = lastUserMsg.content;
      } else if (Array.isArray(lastUserMsg.content)) {
        userMessage = (lastUserMsg.content as TextContent[])
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("");
      }
    }

    // Strip OpenClaw metadata
    userMessage = stripInboundMeta(userMessage);

    if (!userMessage) {
      return streamFn(model, context, options);
    }

    // Only inject tool prompt when the message likely needs tool use, unless the client
    // passed `tools` in the API body (OpenAI) — then always consider injection.
    // This reduces ban risk by keeping most messages short and natural.
    const hasAgentTools = (context.tools?.length ?? 0) > 0;
    const x = context as import("@mariozechner/pi-ai").Context & ZeroTokenContextFields;
    const forceFromApi = x.zeroTokenForceToolPrompt === true;
    const customFnTools: OpenAIFunctionToolItem[] | undefined = x.zeroTokenOpenAITools;
    const injectTools =
      shouldInjectToolPrompt(api) && hasAgentTools && (forceFromApi || needsToolInjection(userMessage));

    // Build the prompt: tool prompt (if applicable) + user message
    const toolPrefix = injectTools
      ? customFnTools?.length
        ? getToolPromptForOpenAIFunctions(api, customFnTools)
        : getToolPrompt(api)
      : "";
    const prompt = injectTools ? toolPrefix + userMessage : userMessage;

    console.log(
      `[WebStreamMiddleware] api=${api} injectTools=${injectTools} promptLen=${prompt.length} userMsgLen=${userMessage.length}`,
    );

    // Create modified context with just the user message.
    // Spread the original context to preserve the full type, then override.
    const modifiedContext = Object.assign({}, context, {
      messages: [{ role: "user" as const, content: prompt }],
      tools: [] as typeof context.tools,
      systemPrompt: "",
    });

    if (!injectTools) {
      // No tool calling — just pass through with cleaned context
      return streamFn(model, modifiedContext, options);
    }

    // --- With tool calling: wrap the output stream ---
    const originalStreamOrPromise = streamFn(model, modifiedContext, options);
    const wrappedStream = createAssistantMessageEventStream();

    // Process events from original stream
    const processEvents = async () => {
      try {
        const originalStream = await Promise.resolve(originalStreamOrPromise);
        let accumulatedText = "";
        let toolCallEmitted = false;

        for await (const event of originalStream) {
          // On stream completion, check final message for tool calls
          if (event.type === "done") {
            // Use final message content (already deduplicated by stream parser)
            // instead of accumulating text_delta events which may contain duplicates
            const finalMsg = event.message;
            if (finalMsg && Array.isArray(finalMsg.content)) {
              for (const part of finalMsg.content) {
                if (part.type === "text" && part.text) {
                  accumulatedText = part.text;
                }
              }
            }

            const toolCall = extractToolCall(accumulatedText);

            if (toolCall) {
              toolCallEmitted = true;
              const toolId = `web_tool_${Date.now()}`;

              // Emit tool call events
              const toolCallPart: ToolCall = {
                type: "toolCall",
                id: toolId,
                name: toolCall.tool,
                arguments: toolCall.parameters,
              };

              const toolMsg: AssistantMessage = {
                role: "assistant",
                content: [toolCallPart],
                stopReason: "toolUse",
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: finalMsg?.usage ?? {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                timestamp: Date.now(),
              };

              wrappedStream.push({
                type: "toolcall_start",
                contentIndex: 0,
                partial: toolMsg,
              });
              wrappedStream.push({
                type: "toolcall_end",
                contentIndex: 0,
                toolCall: toolCallPart,
                partial: toolMsg,
              });
              wrappedStream.push({
                type: "done",
                reason: "toolUse",
                message: toolMsg,
              });
            } else {
              // No tool call — forward the done event as-is
              wrappedStream.push(event);
            }
          } else if (!toolCallEmitted) {
            // Forward non-done events as-is
            wrappedStream.push(event);
          }
        }
      } catch (err) {
        wrappedStream.push({
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
        } as AssistantMessageEvent);
      } finally {
        wrappedStream.end();
      }
    };

    queueMicrotask(() => void processEvents());
    return wrappedStream;
  };
}
