import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  UserMessage,
  AssistantMessage as PiAssistantMessage,
} from "@mariozechner/pi-ai";
import { getWebStreamFactory } from "../streams/web-stream-factories.js";
import { loadCredentials } from "../credentials.js";
import { findModelDefinition, parseCompositeModelId } from "../catalog.js";
import { shouldPreferBrowserChat, tryCreateBrowserPiEventStream } from "./browser-pi-bridge.js";
import { stripInboundMeta } from "../streams/strip-inbound-meta.js";

type OpenAIChatMessage = {
  role: string;
  content?: unknown;
};

type ChatCompletionsBody = {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
};

function isUserRole(role: string | undefined): boolean {
  return (role || "").toLowerCase() === "user";
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (p && typeof p === "object" && "text" in p && typeof (p as { text?: string }).text === "string") {
          return (p as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  if (content && typeof content === "object" && "text" in (content as object)) {
    return String((content as { text: unknown }).text ?? "");
  }
  return String(content ?? "");
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

function openaiMessagesToContext(messages: OpenAIChatMessage[]): Context {
  const systemBits: string[] = [];
  const out: Context["messages"] = [];
  let tick = Date.now();
  for (const m of messages) {
    if (m.role === "system") {
      systemBits.push(extractText(m.content));
      continue;
    }
    if (isUserRole(m.role)) {
      const text = extractText(m.content);
      const msg: UserMessage = {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: tick++,
      };
      out.push(msg);
    } else if (m.role === "assistant") {
      const text = extractText(m.content);
      const stub: PiAssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openai-completions" as Api,
        provider: "openai",
        model: "history",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: tick++,
      };
      out.push(stub);
    }
  }
  return {
    systemPrompt: systemBits.join("\n\n").trim() || undefined,
    messages: out,
  };
}

function buildModel(webApi: string, modelId: string, def: { name: string; reasoning: boolean; contextWindow: number; maxTokens: number }): Model<Api> {
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
  const context = openaiMessagesToContext(body.messages ?? []);
  let eventStream: AsyncIterable<AssistantMessageEvent> = streamFn(model, context, {
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
            delta: { content: `〈thinking〉${ev.delta}`, role: n === 1 ? ("assistant" as const) : undefined },
            finish_reason: null,
          },
        ],
      };
    } else if (ev.type === "done") {
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
