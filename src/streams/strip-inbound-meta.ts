/**
 * Strip inbound metadata blocks injected by OpenClaw into user messages.
 * Web models have no knowledge of OpenClaw internals and will produce
 * garbage when they see these metadata blocks.
 */
export function stripInboundMeta(text: string): string {
  return (
    text
      // Triple-backtick metadata blocks: ```json\n...\n```
      .replace(
        /(?:Conversation info|Sender|Thread starter|Replied message|Forwarded message context|Chat history since last reply)\s*\(untrusted[^)]*\):\s*```json\n[\s\S]*?```\s*/g,
        "",
      )
      // Single-backtick inline metadata: `json{...}`
      .replace(/`json\{[^`]*\}`\s*/g, "")
      // Timestamp prefixes: [Sun 2026-04-05 06:34 GMT+8]
      .replace(
        /\[(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?:\s+GMT[+-]\d+)?\]\s*/g,
        "",
      )
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
