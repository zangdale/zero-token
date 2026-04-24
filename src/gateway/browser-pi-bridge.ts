import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from "@mariozechner/pi-ai";
import type { Api, Provider } from "@mariozechner/pi-ai";

function baseUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function partialMessage(api: string, model: string, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: api as Api,
    provider: api as Provider,
    model,
    usage: baseUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function finalMessage(api: string, model: string, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: api as Api,
    provider: api as Provider,
    model,
    usage: baseUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * 是否需要在传入网关前对「无 user 正文」做 400 校验。chatgpt-web 走 createChatGPTWebStreamFn，不在此执行纯 DOM 路径。
 * gemini / grok：默认（CDP）在页面上键入并读 DOM。ZERO_TOKEN_CHAT_VIA_BROWSER=0 可关闭，仅走 Node 内流式 API。
 */
export function shouldPreferBrowserChat(webApi: string): boolean {
  if (process.env.ZERO_TOKEN_CHAT_VIA_BROWSER === "0") {
    return false;
  }
  return webApi === "chatgpt-web" || webApi === "gemini-web" || webApi === "grok-web";
}

export function tryCreateBrowserPiEventStream(params: {
  webApi: string;
  credential: string;
  userPrompt: string;
  modelId: string;
  signal?: AbortSignal;
}): import("@mariozechner/pi-ai").AssistantMessageEventStream | null {
  if (!shouldPreferBrowserChat(params.webApi)) {
    return null;
  }

  // chatgpt-web：以 createChatGPTWebStreamFn 为主——页内带 sentinel 的 fetch 到 /backend-api/conversation，
  // 失败（如 403）时已在客户端内回退到 DOM。若在此直连 runBrowserDialog，会绕开该路径，常出现“参数/回复异常”。
  if (params.webApi === "chatgpt-web") {
    return null;
  }

  const stream = createAssistantMessageEventStream();
  const { webApi, credential, userPrompt, modelId, signal } = params;
  const api = webApi;
  const model = modelId;

  const run = async () => {
    let prevLen = 0;
    const onCumulative = (text: string) => {
      const delta = text.slice(prevLen);
      prevLen = text.length;
      if (!delta) {
        return;
      }
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta,
        partial: partialMessage(api, model, text),
      } as AssistantMessageEvent);
    };

    try {
      if (webApi === "grok-web") {
        const { GrokWebClientBrowser } = await import("../providers/grok-web-client-browser.js");
        const o = JSON.parse(credential) as { cookie: string; userAgent: string };
        const c = new GrokWebClientBrowser(o);
        await c.init();
        const finalText = await c.runBrowserDialog({
          message: userPrompt,
          signal,
          onCumulativeText: onCumulative,
        });
        stream.push({
          type: "done",
          reason: "stop",
          message: finalMessage(api, model, finalText),
        } as AssistantMessageEvent);
      } else if (webApi === "gemini-web") {
        const { GeminiWebClientBrowser } = await import("../providers/gemini-web-client-browser.js");
        const o = JSON.parse(credential) as { cookie: string; userAgent: string };
        const c = new GeminiWebClientBrowser(o);
        await c.init();
        const finalText = await c.runBrowserDialog({
          message: userPrompt,
          signal,
          onCumulativeText: onCumulative,
        });
        stream.push({
          type: "done",
          reason: "stop",
          message: finalMessage(api, model, finalText),
        } as AssistantMessageEvent);
      } else {
        throw new Error(`[zero-token] 未实现 ${webApi} 的纯浏览器聊天路径`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      stream.push({
        type: "error",
        reason: "error",
        error: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: msg,
          api: api as Api,
          provider: api as Provider,
          model,
          usage: baseUsage(),
          timestamp: Date.now(),
        } as AssistantMessage,
      } as AssistantMessageEvent);
    } finally {
      stream.end();
    }
  };

  void run();
  return stream;
}
