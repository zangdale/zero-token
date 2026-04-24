/**
 * Core tool definitions for web models.
 * Kept minimal (~350 chars total) to avoid triggering rate limits.
 */

export interface WebToolDef {
  name: string;
  description: string;
  parameters: Record<string, string>;
}

export const WEB_CORE_TOOLS: WebToolDef[] = [
  { name: "web_search", description: "Search web", parameters: { query: "string" } },
  { name: "web_fetch", description: "Fetch URL", parameters: { url: "string" } },
  { name: "exec", description: "Run command", parameters: { command: "string" } },
  { name: "read", description: "Read file", parameters: { path: "string" } },
  { name: "write", description: "Write file", parameters: { path: "string", content: "string" } },
  { name: "message", description: "Send msg", parameters: { text: "string", channel: "string" } },
];

/** Compact JSON string of tool definitions */
export function toolDefsJson(): string {
  return JSON.stringify(
    WEB_CORE_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  );
}
