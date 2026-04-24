import { Type, type TSchema, type Tool } from "@mariozechner/pi-ai";
import type {
  AssistantMessage as PiAssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";
import { stripInboundMeta } from "../streams/strip-inbound-meta.js";
import { extractText } from "./message-text.js";

/** OpenAI Chat Completions: function tool in `tools` array. */
export type OpenAIFunctionToolItem = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type OpenAIChatMessage = {
  role: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type?: string;
    function: { name: string; arguments: string };
  }>;
};

export type ZeroTokenContextFields = {
  /** Carried alongside `Context` in gateway (middleware reads via intersection). */
  zeroTokenOpenAITools?: OpenAIFunctionToolItem[];
  zeroTokenForceToolPrompt?: boolean;
};

/** JSON Schema object → simple TypeBox schema (fallback `Type.Any()` for unknown). */
function jsonSchemaToTypeboxParameters(schema: Record<string, unknown> | undefined): TSchema {
  if (!schema || typeof schema !== "object" || (schema as { type?: string }).type !== "object") {
    return Type.Any();
  }
  const props = (schema as { properties?: Record<string, unknown> }).properties;
  if (!props || typeof props !== "object") {
    return Type.Object({});
  }
  const required = new Set(
    Array.isArray((schema as { required?: unknown[] }).required)
      ? (schema as { required: string[] }).required
      : [],
  );
  const tProps: Record<string, TSchema> = {};
  for (const [key, prop] of Object.entries(props)) {
    tProps[key] = jsonSchemaPropertyToTypebox(prop, required.has(key));
  }
  return Type.Object(tProps);
}

function jsonSchemaPropertyToTypebox(s: unknown, _required: boolean): TSchema {
  if (!s || typeof s !== "object") return Type.Any();
  const t = (s as { type?: string; items?: unknown }).type;
  switch (t) {
    case "string":
      return Type.String();
    case "number":
      return Type.Number();
    case "integer":
      return Type.Integer();
    case "boolean":
      return Type.Boolean();
    case "array": {
      const it = (s as { items?: unknown }).items;
      return Type.Array(
        it && typeof it === "object" && (it as { type?: string }).type === "string"
          ? Type.String()
          : Type.Any(),
      );
    }
    case "object": {
      const p = (s as { properties?: Record<string, unknown> }).properties;
      if (p && typeof p === "object")
        return jsonSchemaToTypeboxParameters(s as Record<string, unknown>) as TSchema;
      return Type.Object({});
    }
    default:
      return Type.Any();
  }
}

export function openAIFunctionToolsToPi(tools: OpenAIFunctionToolItem[] | undefined): Tool[] {
  if (!Array.isArray(tools) || tools.length === 0) {
    return [];
  }
  const out: Tool[] = [];
  for (const t of tools) {
    if (t.type !== "function" || !t.function?.name) continue;
    out.push({
      name: t.function.name,
      description: t.function.description?.trim() || t.function.name,
      parameters: jsonSchemaToTypeboxParameters(t.function.parameters as Record<string, unknown> | undefined),
    });
  }
  return out;
}

type ToolChoice = "auto" | "none" | "required" | { type: "function"; function: { name: string } };

/**
 * 将 `tools` + `tool_choice` 与 OpenAI 消息条转成 pi-ai `Context`（含 tool / assistant+tool_calls）。
 */
export function buildPiContextFromOpenAIBody(params: {
  messages: OpenAIChatMessage[];
  tools?: OpenAIFunctionToolItem[];
  tool_choice?: ToolChoice;
}): { context: import("@mariozechner/pi-ai").Context; zero: ZeroTokenContextFields } {
  const choice = params.tool_choice;
  const rawTools = choice === "none" ? [] : (params.tools ?? []);
  const piTools = openAIFunctionToolsToPi(rawTools.length > 0 ? rawTools : undefined);
  const forceToolPrompt = rawTools.length > 0;

  const systemBits: string[] = [];
  const out: Message[] = [];
  let tick = Date.now();
  const toolIdToName = new Map<string, string>();

  for (const m of params.messages) {
    if (m.role === "system") {
      systemBits.push(extractText(m.content));
      continue;
    }
    if (m.role === "tool") {
      const id = m.tool_call_id ?? "";
      if (!id) continue;
      const tr: ToolResultMessage = {
        role: "toolResult",
        toolCallId: id,
        toolName: (m.name as string) || toolIdToName.get(id) || "tool",
        content: [{ type: "text", text: extractText(m.content) }],
        isError: false,
        timestamp: tick++,
      };
      out.push(tr);
      continue;
    }
    if (m.role === "user") {
      const text = extractText(m.content);
      const msg: UserMessage = {
        role: "user",
        content: [{ type: "text", text: stripInboundMeta(text) }],
        timestamp: tick++,
      };
      out.push(msg);
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        toolIdToName.set(tc.id, tc.function.name);
      }
      const textPart = m.content != null && String(extractText(m.content)).trim() ? extractText(m.content) : "";
      const content: PiAssistantMessage["content"] = [];
      if (textPart) {
        content.push({ type: "text", text: textPart });
      }
      for (const tc of m.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
        } catch {
          args = { _raw: tc.function.arguments };
        }
        content.push({
          type: "toolCall",
          id: tc.id,
          name: tc.function.name,
          arguments: args,
        });
      }
      const stub: PiAssistantMessage = {
        role: "assistant",
        content,
        api: "openai-completions" as import("@mariozechner/pi-ai").Api,
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
      continue;
    }
    if (m.role === "assistant") {
      const text = extractText(m.content);
      const stub: PiAssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openai-completions" as import("@mariozechner/pi-ai").Api,
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

  const systemPrompt = systemBits.join("\n\n").trim() || undefined;
  return {
    context: {
      systemPrompt,
      messages: out,
      tools: piTools.length > 0 ? piTools : undefined,
    },
    zero: {
      zeroTokenOpenAITools: rawTools.length > 0 ? rawTools : undefined,
      zeroTokenForceToolPrompt: forceToolPrompt,
    },
  };
}

