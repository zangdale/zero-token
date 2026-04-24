import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, ToolCall } from "@mariozechner/pi-ai";
import { getWebStreamFactory } from "../streams/web-stream-factories.js";
import { loadCredentials } from "../credentials.js";
import { findModelDefinition, parseCompositeModelId } from "../catalog.js";
import { shouldPreferBrowserChat, tryCreateBrowserPiEventStream } from "./browser-pi-bridge.js";
import { extractText } from "./message-text.js";
import { stripInboundMeta } from "../streams/strip-inbound-meta.js";
import {
  type OpenAIFunctionToolItem,
  type OpenAIChatMessage,
  buildPiContextFromOpenAIBody,
} from "./openai-tool-bridge.js";

type ChatCompletionsBody = {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  /** OpenAI 可选：同一 `user` 在部分提供方（如 `qwen-cn-web`）内复用浏览器侧同一会话 */
  user?: string;
  /** OpenAI Chat Completions: `tools` + `tool_choice` */
  tools?: OpenAIFunctionToolItem[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
};

function isUserRole(role: string | undefined): boolean {
  return (role || "").toLowerCase() === "user";
}

/**
 * 浏览器里仅模拟「当前这一条」发入输入框。与 `createChatGPTWebStreamFn` 一致，只取**最后一条 user**，
 * 经 stripInboundMeta；若再拼多轮为 `user:\\n...\\n\\nuser:`，会整段被键入，出现 "user: 你好 user: ..." 等异常。
 */
function lastUserPromptForBrowserInput(messages: OpenAIChatMessage[]): string {
  const last = [...messages].toReversed().find((m) => isUserRole(m.role));
  if (!last) {
    return "";
  }
  return stripInboundMeta(extractText(last.content).trim());
}

function buildModel(
  webApi: string,
  modelId: string,
  def: { name: string; reasoning: boolean; contextWindow: number; maxTokens: number },
): Model<Api> {
  return {
    id: modelId,
    name: def.name,
    api: webApi as Api,
    provider: webApi,
    baseUrl: "https://web",
    reasoning: def.reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: def.contextWindow,
    maxTokens: def.maxTokens,
  };
}

export class ChatGatewayError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function mergeContextWithFlags(
  context: Context,
  extra: { zeroTokenOpenAITools?: unknown; zeroTokenForceToolPrompt?: boolean; user?: string },
): Context {
  return Object.assign(context, extra) as Context;
}

export async function runChatCompletion(body: ChatCompletionsBody, signal?: AbortSignal) {
  const parsed = parseCompositeModelId(body.model);
  if (!parsed) {
    throw new ChatGatewayError(
      400,
      `Model must be "webApi/modelId" (e.g. deepseek-web/deepseek-chat). Got: ${body.model}`,
    );
  }
  const { webApi, modelId } = parsed;
  const found = await findModelDefinition(webApi, modelId);
  if (!found) {
    throw new ChatGatewayError(400, `Unknown model: ${body.model}`);
  }
  const creds = loadCredentials();
  const credential = creds[webApi];
  if (!credential?.trim()) {
    throw new ChatGatewayError(
      401,
      `No stored credential for ${webApi}. Run: npm run login -- ${webApi} (or write ${webApi} into ~/.zero-token/credentials.json)`,
    );
  }
  const model = buildModel(webApi, modelId, found.def);
  const { context, zero } = buildPiContextFromOpenAIBody({
    messages: body.messages ?? [],
    tools: body.tools,
    tool_choice: body.tool_choice,
  });
  const merged = mergeContextWithFlags(context, { ...zero, ...(body.user?.trim() ? { user: body.user.trim() } : {}) });

  const userPrompt = lastUserPromptForBrowserInput(body.messages ?? []);
  if (shouldPreferBrowserChat(webApi) && !userPrompt.trim()) {
    throw new ChatGatewayError(400, "需要至少一条 user 消息，且去掉元数据后内容非空。");
  }
  const browserFirst = tryCreateBrowserPiEventStream({
    webApi,
    credential,
    userPrompt,
    modelId,
    signal,
  });
  if (browserFirst) {
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      throw new ChatGatewayError(
        400,
        "当前提供方在浏览器内对话路径下（gemini-web / grok 的默认 CDP 等）暂不支持 `tools`；可设置环境变量 ZERO_TOKEN_CHAT_VIA_BROWSER=0 后重试。",
      );
    }
    let eventStream: AsyncIterable<AssistantMessageEvent> = browserFirst;
    if (eventStream && typeof (eventStream as { then?: unknown }).then === "function") {
      const awaited = (await (eventStream as unknown as Promise<AsyncIterable<AssistantMessageEvent>>)) as AsyncIterable<AssistantMessageEvent>;
      eventStream = awaited;
    }
    return { stream: eventStream, model, webApi, modelId };
  }
  const factory = getWebStreamFactory(webApi) as ((c: string) => StreamFn) | undefined;
  if (!factory) {
    throw new ChatGatewayError(500, `No stream factory for api ${webApi}`);
  }
  const streamFn = factory(credential);
  let eventStream: AsyncIterable<AssistantMessageEvent> = streamFn(model, merged, {
    signal,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
  }) as AsyncIterable<AssistantMessageEvent>;
  if (eventStream && typeof (eventStream as { then?: unknown }).then === "function") {
    const awaited = (await (eventStream as unknown as Promise<AsyncIterable<AssistantMessageEvent>>)) as AsyncIterable<AssistantMessageEvent>;
    eventStream = awaited;
  }
  return { stream: eventStream, model, webApi, modelId };
}

function assistantMessageToText(m: AssistantMessage): string {
  if (!m.content || !Array.isArray(m.content)) {
    return "";
  }
  let t = "";
  for (const part of m.content) {
    if (part.type === "text") {
      t += part.text;
    } else if (part.type === "thinking") {
      t += part.thinking;
    }
  }
  return t;
}

function toolCallsOpenAIFormat(m: AssistantMessage) {
  const out: { id: string; type: "function"; function: { name: string; arguments: string } }[] = [];
  if (!m.content || !Array.isArray(m.content)) {
    return out;
  }
  for (const part of m.content) {
    if (part.type === "toolCall") {
      const p = part as ToolCall;
      out.push({
        id: p.id,
        type: "function" as const,
        function: {
          name: p.name,
          arguments: JSON.stringify(p.arguments ?? {}),
        },
      });
    }
  }
  return out;
}

export async function collectNonStreamingText(
  eventStream: AsyncIterable<AssistantMessageEvent>,
  meta: { webApi: string; modelId: string },
) {
  const id = "chatcmpl-" + randomId();
  for await (const ev of eventStream) {
    if (ev.type === "error") {
      const msg = ev.error.errorMessage || "stream error";
      throw new ChatGatewayError(502, msg);
    }
    if (ev.type === "done") {
      const text = assistantMessageToText(ev.message);
      const toolCalls = toolCallsOpenAIFormat(ev.message);
      if (toolCalls.length > 0) {
        return {
          id,
          object: "chat.completion" as const,
          created: Math.floor(Date.now() / 1000),
          model: `${meta.webApi}/${meta.modelId}`,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant" as const,
                content: text.length > 0 ? text : null,
                tool_calls: toolCalls,
              },
              finish_reason: "tool_calls" as const,
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      }
      return {
        id,
        object: "chat.completion" as const,
        created: Math.floor(Date.now() / 1000),
        model: `${meta.webApi}/${meta.modelId}`,
        choices: [
          {
            index: 0,
            message: { role: "assistant" as const, content: text },
            finish_reason: "stop" as const,
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    }
  }
  throw new ChatGatewayError(502, "Stream ended without done event");
}

function randomId() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

export async function* openAIStreamingChunks(
  eventStream: AsyncIterable<AssistantMessageEvent>,
  params: { id: string; webApi: string; modelId: string },
) {
  const id = params.id;
  const model = `${params.webApi}/${params.modelId}`;
  let n = 0;
  for await (const ev of eventStream) {
    if (ev.type === "error") {
      const msg = ev.error.errorMessage || "stream error";
      throw new ChatGatewayError(502, msg);
    }
    if (ev.type === "text_delta" && ev.delta) {
      n++;
      yield {
        id,
        object: "chat.completion.chunk" as const,
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: { content: ev.delta, role: n === 1 ? ("assistant" as const) : undefined },
            finish_reason: null,
          },
        ],
      };
    } else if (ev.type === "thinking_delta" && ev.delta) {
      n++;
      yield {
        id,
        object: "chat.completion.chunk" as const,
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: {
              content: `〈thinking〉${ev.delta}`,
              role: n === 1 ? ("assistant" as const) : undefined,
            },
            finish_reason: null,
          },
        ],
      };
    } else if (ev.type === "done") {
      const tcalls = toolCallsOpenAIFormat(ev.message);
      if (tcalls.length > 0) {
        n++;
        yield {
          id,
          object: "chat.completion.chunk" as const,
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: tcalls.map((tc, i) => ({
                  index: i,
                  id: tc.id,
                  type: "function" as const,
                  function: { name: tc.function.name, arguments: tc.function.arguments },
                })),
                role: n === 1 ? ("assistant" as const) : undefined,
              },
              finish_reason: null,
            },
          ],
        };
        yield {
          id,
          object: "chat.completion.chunk" as const,
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" as const }],
        };
        return;
      }
      yield {
        id,
        object: "chat.completion.chunk" as const,
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" as const }],
      };
      return;
    }
  }
  yield {
    id,
    object: "chat.completion.chunk" as const,
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" as const }],
  };
}

export function formatSseData(obj: unknown) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
