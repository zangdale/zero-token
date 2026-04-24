/**
 * Per-model tool calling prompt templates.
 *
 * Reference:
 * - Paper: https://arxiv.org/html/2407.04997v1
 * - ComfyUI LLM Party: https://github.com/heshengtao/comfyui_LLM_party
 */

import { toolDefsJson } from "./web-tool-defs.js";
import type { OpenAIFunctionToolItem } from "../gateway/openai-tool-bridge.js";

const TOOL_DEFS = toolDefsJson();

// Example-based teaching (key insight from arXiv:2407.04997 and ComfyUI LLM Party):
// A trivial example teaches the model the output format without confusing it with real tools.
const TOOL_EXAMPLE = `Example: to add 1 to number 5, return:
\`\`\`tool_json
{"tool":"plus_one","parameters":{"number":"5"}}
\`\`\`
(plus_one is just an example, not a real tool)`;

function enStrictBody(toolDefs: string) {
  return `Tools: ${toolDefs}

${TOOL_EXAMPLE}

Your actual tools are listed above. To use one, reply ONLY with the tool_json block. No extra text.
No tool needed? Answer directly.

`;
}
function enBody(toolDefs: string) {
  return `Tools: ${toolDefs}

${TOOL_EXAMPLE}

Your actual tools are listed above. To use one, reply ONLY with the tool_json block.
No tool needed? Answer directly.

`;
}
function cnBody(toolDefs: string) {
  return `工具: ${toolDefs}

示例: 要给数字5加1，返回:
\`\`\`tool_json
{"tool":"plus_one","parameters":{"number":"5"}}
\`\`\`
(plus_one仅为示例，非真实工具)

 你的真实工具见上方列表。需要时只回复tool_json块。不需要则直接回答。

`;
}

const EN_TEMPLATE = enBody(TOOL_DEFS);
const EN_STRICT_TEMPLATE = enStrictBody(TOOL_DEFS);
const CN_TEMPLATE = cnBody(TOOL_DEFS);

/** No web models skip prompt injection — web interfaces don't pass native tools.
 *  Even DeepSeek/Claude/GLM need prompt injection when accessed via browser. */
const NATIVE_TOOL_MODELS = new Set<string>();

/** Models excluded from tool calling entirely */
const EXCLUDED_MODELS = new Set(["perplexity-web"]);

/** Chinese-language models */
const CN_MODELS = new Set([
  "deepseek-web",
  "doubao-web",
  "qwen-cn-web",
  "kimi-web",
  "glm-web",
  "xiaomimo-web",
]);

/** Models that tend to add extra text after JSON */
const STRICT_MODELS = new Set(["chatgpt-web"]);

export function shouldInjectToolPrompt(api: string): boolean {
  return !NATIVE_TOOL_MODELS.has(api) && !EXCLUDED_MODELS.has(api);
}

export function getToolPrompt(api: string): string {
  if (STRICT_MODELS.has(api)) {
    return EN_STRICT_TEMPLATE;
  }
  if (CN_MODELS.has(api)) {
    return CN_TEMPLATE;
  }
  return EN_TEMPLATE;
}

function openAiFunctionToolsToDefString(tools: OpenAIFunctionToolItem[]): string {
  return JSON.stringify(
    tools
      .filter((t) => t.type === "function" && t.function?.name)
      .map((t) => ({
        name: t.function.name,
        description: t.function.description ?? "",
        parameters: t.function.parameters ?? {},
      })),
  );
}

/** 使用客户端 `POST` 里的 `tools` 列表拼 prompt（与内置 `WEB_CORE_TOOLS` 同格式要求）。 */
export function getToolPromptForOpenAIFunctions(api: string, tools: OpenAIFunctionToolItem[]): string {
  const defs = openAiFunctionToolsToDefString(tools);
  if (STRICT_MODELS.has(api)) {
    return enStrictBody(defs);
  }
  if (CN_MODELS.has(api)) {
    return cnBody(defs);
  }
  return enBody(defs);
}

/** Format tool result for feedback to the model */
export function formatToolResult(toolName: string, result: string): string {
  return `Tool ${toolName} returned: ${result}\nPlease continue answering based on this result.`;
}
