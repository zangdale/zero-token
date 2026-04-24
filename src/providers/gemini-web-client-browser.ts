import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { getHeadersWithAuth, getChromeWebSocketUrl, launchOpenClawChrome } from "../lib/cdp.js";
import { resolveBrowserConfig, resolveProfile, loadConfig } from "../lib/browser-context.js";

export interface GeminiWebClientOptions {
  cookie: string;
  userAgent: string;
}

export class GeminiWebClientBrowser {
  private options: GeminiWebClientOptions;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private initialized = false;

  constructor(options: GeminiWebClientOptions) {
    this.options = options;
  }

  private parseCookies(): Array<{ name: string; value: string; domain: string; path: string }> {
    return this.options.cookie
      .split(";")
      .filter((c) => c.trim().includes("="))
      .map((cookie) => {
        const [name, ...valueParts] = cookie.trim().split("=");
        return {
          name: name?.trim() ?? "",
          value: valueParts.join("=").trim(),
          domain: ".google.com",
          path: "/",
        };
      })
      .filter((c) => c.name.length > 0);
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const rootConfig = loadConfig();
    const browserConfig = resolveBrowserConfig(rootConfig.browser, rootConfig);
    const profile = resolveProfile(browserConfig, browserConfig.defaultProfile);
    if (!profile) {
      throw new Error(`Could not resolve browser profile '${browserConfig.defaultProfile}'`);
    }

    let wsUrl: string | null = null;

    if (browserConfig.attachOnly) {
      console.log(`[Gemini Web Browser] Connecting to existing Chrome at ${profile.cdpUrl}`);
      for (let i = 0; i < 10; i++) {
        wsUrl = await getChromeWebSocketUrl(profile.cdpUrl, 2000);
        if (wsUrl) {
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!wsUrl) {
        throw new Error(
          `Failed to connect to Chrome at ${profile.cdpUrl}. ` +
            `Make sure Chrome is running in debug mode (./start-chrome-debug.sh)`,
        );
      }
    } else {
      const running = await launchOpenClawChrome(browserConfig, profile);
      const cdpUrl = `http://127.0.0.1:${running.cdpPort}`;
      for (let i = 0; i < 10; i++) {
        wsUrl = await getChromeWebSocketUrl(cdpUrl, 2000);
        if (wsUrl) {
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!wsUrl) {
        throw new Error(`Failed to resolve Chrome WebSocket URL from ${cdpUrl}`);
      }
    }

    const connectedBrowser = await chromium.connectOverCDP(wsUrl, {
      headers: getHeadersWithAuth(wsUrl),
    });
    this.browser = connectedBrowser;
    this.context = connectedBrowser.contexts()[0];

    const pages = this.context.pages();
    const geminiPage = pages.find((p) => p.url().includes("gemini.google.com"));
    if (geminiPage) {
      console.log(`[Gemini Web Browser] Found existing Gemini page`);
      this.page = geminiPage;
    } else {
      this.page = await this.context.newPage();
      await this.page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" });
    }

    const cookies = this.parseCookies();
    if (cookies.length > 0) {
      try {
        await this.context.addCookies(cookies);
      } catch (e) {
        console.warn("[Gemini Web Browser] Failed to add some cookies:", e);
      }
    }

    this.initialized = true;
  }

  public async runBrowserDialog(params: {
    message: string;
    signal?: AbortSignal;
    onCumulativeText?: (text: string) => void;
  }): Promise<string> {
    if (!this.page) {
      throw new Error("GeminiWebClientBrowser not initialized");
    }

    const page = this.page;

    const inputSelectors = [
      'textarea[placeholder*="Gemini"]',
      'textarea[placeholder*="问问"]',
      'textarea[aria-label*="prompt"]',
      "textarea",
      'div[role="textbox"]',
      '[contenteditable="true"]',
    ];
    let inputHandle = null;
    for (const sel of inputSelectors) {
      inputHandle = await page.$(sel);
      if (inputHandle) {
        break;
      }
    }
    if (!inputHandle) {
      throw new Error("Gemini DOM 模拟失败: 找不到输入框");
    }

    // Use Playwright native APIs for reliable input
    await inputHandle.click();
    await page.waitForTimeout(300);
    await page.keyboard.type(params.message, { delay: 20 });
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    console.log("[Gemini Web Browser] DOM: typed message and pressed Enter");

    console.log("[Gemini Web Browser] DOM 模拟已发送，轮询等待回复...");

    const maxWaitMs = 120000;
    const pollIntervalMs = 2000;
    let lastText = "";
    let stableCount = 0;
    const signal = params.signal;
    const onCumulative = params.onCumulativeText;

    for (let elapsed = 0; elapsed < maxWaitMs; elapsed += pollIntervalMs) {
      if (signal?.aborted) {
        throw new Error("Gemini 请求已取消");
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));

      const result = await this.page.evaluate(() => {
        // 清理不可见 Unicode 字符
        const clean = (t: string) => t.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();

        // 使用 innerText（排除隐藏元素和 CSS 控制的不可见内容）而非 textContent
        const getText = (el: Element): string => {
          const raw = (el as HTMLElement).innerText ?? "";
          return clean(raw);
        };

        // 排除区域检测
        const sidebarRoot = document.querySelector('[aria-label*="对话"], [class*="sidebar"], nav');
        const inputEl = document.querySelector(
          '[contenteditable="true"], textarea, [placeholder*="Gemini"], [placeholder*="问问"]',
        );
        const inputRoot =
          inputEl?.closest("form") ??
          inputEl?.closest("[class*='input']") ??
          inputEl?.parentElement?.parentElement;

        const isExcluded = (el: Element) => sidebarRoot?.contains(el) || inputRoot?.contains(el);

        // 噪声文本过滤
        const noisePatterns = [
          "Ask Gemini",
          "问问 Gemini",
          "Enter a prompt",
          "输入提示",
          "需要我为你做些什么",
          "发起新对话",
          "我的内容",
          "设置和帮助",
          "制作图片",
          "创作音乐",
          "帮我学习",
          "随便写点什么",
          "给我的一天注入活力",
          "升级到 Google AI Plus",
          "正在加载",
          "复制",
          "分享",
          "修改",
          "朗读",
        ];
        const isNoise = (t: string) =>
          t.length < 20 ||
          noisePatterns.some((p) => t.includes(p)) ||
          /^(你好|需要我|sage)/i.test(t);

        // 去除回复中的 UI 按钮文字（如 "复制 分享 修改 朗读" 等尾部噪声）
        const stripTrailingUI = (t: string) =>
          t
            .replace(
              /\n?\s*(复制|分享|修改|朗读|Copy|Share|Edit|Read aloud|thumb_up|thumb_down|more_vert)[\s\n]*/gi,
              "",
            )
            .replace(/\s+$/, "");

        const main =
          document.querySelector("main") ??
          document.querySelector('[role="main"]') ??
          document.querySelector('[class*="chat"]') ??
          document.body;
        const scoped = main === document.body ? document : main;

        let text = "";

        // 策略 1：精确匹配 Gemini 模型回复容器（只取最后一条）
        const modelSelectors = [
          "model-response message-content", // Gemini 2025+ web component
          '[data-message-author="model"] .message-content',
          '[data-message-author="model"]',
          '[data-sender="model"]',
          '[class*="model-response"] [class*="markdown"]',
          '[class*="model-response"]',
          '[class*="response-content"] [class*="markdown"]',
          '[class*="response-content"]',
        ];

        for (const sel of modelSelectors) {
          const els = scoped.querySelectorAll(sel);
          // 从最后一个元素开始（最新回复）
          for (let i = els.length - 1; i >= 0; i--) {
            const el = els[i];
            if (isExcluded(el)) {
              continue;
            }
            const t = getText(el);
            if (t.length >= 30 && !isNoise(t)) {
              text = stripTrailingUI(t);
              break;
            }
          }
          if (text) {
            break;
          }
        }

        // 策略 2（受限回退）：只在 main 区域内找 markdown 渲染块，不匹配泛化选择器
        if (!text) {
          const fallbackSelectors = ['[class*="markdown"]', "article"];
          for (const sel of fallbackSelectors) {
            const els = scoped.querySelectorAll(sel);
            for (let i = els.length - 1; i >= 0; i--) {
              const el = els[i];
              if (isExcluded(el)) {
                continue;
              }
              const t = getText(el);
              if (t.length >= 30 && !isNoise(t)) {
                text = stripTrailingUI(t);
                break;
              }
            }
            if (text) {
              break;
            }
          }
        }

        const stopBtn = document.querySelector(
          '[aria-label*="Stop"], [aria-label*="stop"], [aria-label*="停止"]',
        );
        const isStreaming = !!stopBtn;
        return { text, isStreaming };
      });

      // 忽略过短内容（<40 字多为问候/按钮；日志 38 字为误抓问候语）
      const minLen = 40;
      if (result.text && result.text.length < minLen && result.text.length > 0) {
        console.log(
          `[Gemini Web Browser] 忽略过短内容(${result.text.length}字): ${result.text.slice(0, 50)}...`,
        );
      }
      if (result.text && result.text.length >= minLen) {
        if (result.text !== lastText) {
          lastText = result.text;
          onCumulative?.(lastText);
          stableCount = 0;
        } else {
          stableCount++;
          if (!result.isStreaming && stableCount >= 2) {
            break;
          }
        }
      }
    }

    if (!lastText) {
      throw new Error(
        "Gemini DOM 模拟：未检测到回复。请确保 gemini.google.com 页面已打开、已登录，且输入框可见。",
      );
    }
    onCumulative?.(lastText);
    return lastText;
  }

  private async chatCompletionsViaDOM(params: {
    message: string;
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>> {
    const lastText = await this.runBrowserDialog(params);
    const sseLine = `data: ${JSON.stringify({ text: lastText })}\n`;
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseLine));
        controller.close();
      },
    });
  }

  async chatCompletions(params: {
    conversationId?: string;
    message: string;
    model: string;
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>> {
    if (!this.page) {
      throw new Error("GeminiWebClientBrowser not initialized");
    }

    const { message } = params;
    console.log("[Gemini Web Browser] 使用 DOM 模拟发送消息...");

    return this.chatCompletionsViaDOM({
      message,
      signal: params.signal,
    });
  }

  async close(): Promise<void> {
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    this.initialized = false;
  }
}
