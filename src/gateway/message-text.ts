/**
 * 从 OpenAI 风格 message `content` 中取出纯文本（string / 多段 text / 对象）。
 */
export function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (p && typeof p === "object" && "text" in p && typeof (p as { text?: string }).text === "string") {
          return (p as { text: string }).text;
        }
        if (p && typeof p === "object" && "type" in p) {
          const t = p as { type: string; text?: string };
          if (t.type === "text" && typeof t.text === "string") {
            return t.text;
          }
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
