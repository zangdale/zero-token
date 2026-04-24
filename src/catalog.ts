import * as bridge from "./bridge/web-providers.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "./types/models.js";

const providerBuilders: Array<{
  id: string;
  build: () => Promise<ModelProviderConfig> | ModelProviderConfig;
}> = [
  { id: "deepseek-web", build: () => bridge.buildDeepseekWebProvider() },
  { id: "claude-web", build: () => bridge.buildClaudeWebProvider() },
  { id: "chatgpt-web", build: () => bridge.buildChatGPTWebProvider() },
  { id: "qwen-web", build: () => bridge.buildQwenWebProvider() },
  { id: "qwen-cn-web", build: () => bridge.buildQwenCNWebProvider() },
  { id: "kimi-web", build: () => bridge.buildKimiWebProvider() },
  { id: "gemini-web", build: () => bridge.buildGeminiWebProvider() },
  { id: "grok-web", build: () => bridge.buildGrokWebProvider() },
  { id: "glm-web", build: () => bridge.buildZWebProvider() },
  { id: "glm-intl-web", build: () => bridge.buildGlmIntlWebProvider() },
  { id: "perplexity-web", build: () => bridge.buildPerplexityWebProvider() },
  { id: "doubao-web", build: () => bridge.buildDoubaoWebProvider() },
  { id: "xiaomimo-web", build: () => Promise.resolve(bridge.buildXiaomiMimoWebProvider()) },
];

let cached: ModelProviderConfig[] | null = null;

export async function getAllProviders(): Promise<ModelProviderConfig[]> {
  if (cached) {
    return cached;
  }
  const out: ModelProviderConfig[] = [];
  for (const b of providerBuilders) {
    out.push(await b.build());
  }
  cached = out;
  return out;
}

export function clearCatalogCache() {
  cached = null;
}

export async function findModelDefinition(
  webApi: string,
  modelId: string,
): Promise<{ provider: ModelProviderConfig; def: ModelDefinitionConfig } | null> {
  const providers = await getAllProviders();
  for (const p of providers) {
    if (p.api !== webApi) {
      continue;
    }
    const def = p.models.find((m) => m.id === modelId);
    if (def) {
      return { provider: p, def };
    }
  }
  return null;
}

export type OpenAIModelRow = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
};

export async function listOpenAIModels(): Promise<OpenAIModelRow[]> {
  const providers = await getAllProviders();
  const created = Math.floor(Date.now() / 1000);
  const rows: OpenAIModelRow[] = [];
  for (const p of providers) {
    const owner = p.api;
    for (const m of p.models) {
      rows.push({
        id: `${owner}/${m.id}`,
        object: "model",
        created,
        owned_by: owner,
      });
    }
  }
  return rows;
}

/** Parse "webApi/modelId" or plain model id (legacy). */
export function parseCompositeModelId(
  raw: string,
): { webApi: string; modelId: string } | null {
  const s = raw.trim();
  const idx = s.indexOf("/");
  if (idx <= 0) {
    return null;
  }
  const webApi = s.slice(0, idx);
  const modelId = s.slice(idx + 1);
  if (!webApi || !modelId) {
    return null;
  }
  return { webApi, modelId };
}
