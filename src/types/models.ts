/**
 * Minimal model catalog types (subset of OpenClaw), used by web clients and bridge.
 */
export type ModelApi =
  | "deepseek-web"
  | "claude-web"
  | "doubao-web"
  | "chatgpt-web"
  | "qwen-web"
  | "qwen-cn-web"
  | "kimi-web"
  | "gemini-web"
  | "grok-web"
  | "glm-web"
  | "glm-intl-web"
  | "perplexity-web"
  | "xiaomimo-web"
  | string;

export type ModelDefinitionConfig = {
  id: string;
  name: string;
  api?: ModelApi;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  /** Some catalog entries use this alias (Claude). */
  maxOutputTokens?: number;
  headers?: Record<string, string>;
  /** Optional provider hint used by some web clients (e.g. catalog mapping). */
  provider?: string;
  compat?: Record<string, unknown>;
};

export type ModelProviderConfig = {
  baseUrl: string;
  apiKey?: string;
  /** Web transport id, e.g. deepseek-web */
  api: ModelApi;
  models: ModelDefinitionConfig[];
};
