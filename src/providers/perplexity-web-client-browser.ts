import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { getHeadersWithAuth, getChromeWebSocketUrl, launchOpenClawChrome } from "../lib/cdp.js";
import { resolveBrowserConfig, resolveProfile, loadConfig } from "../lib/browser-context.js";
import type { ModelDefinitionConfig } from "../types/models.js";

export interface PerplexityWebClientOptions {
  cookie: string;
  userAgent?: string;
}

const PERPLEXITY_BASE_URL = "https://www.perplexity.ai";

export class PerplexityWebClientBrowser {
  private options: PerplexityWebClientOptions;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private initialized = false;
  lastConversationId: string | undefined;

  constructor(options: PerplexityWebClientOptions | string) {
    if (typeof options === "string") {
      try {
        const parsed = JSON.parse(options) as PerplexityWebClientOptions;
        this.options = { cookie: parsed.cookie, userAgent: parsed.userAgent };
      } catch {
        this.options = { cookie: options, userAgent: "Mozilla/5.0" };
      }
    } else {
      this.options = options;
    }
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
          domain: ".perplexity.ai",
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
      console.log(`[Perplexity Web Browser] Connecting to existing Chrome at ${profile.cdpUrl}`);
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
            `Make sure Chrome is running in debug mode.`,
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
    const perplexityPage = pages.find((p) => p.url().includes("perplexity.ai"));
    if (perplexityPage) {
      console.log(`[Perplexity Web Browser] Found existing Perplexity page`);
      this.page = perplexityPage;
    } else {
      this.page = await this.context.newPage();
      await this.page.goto(PERPLEXITY_BASE_URL, { waitUntil: "domcontentloaded" });
    }

    const cookies = this.parseCookies();
    if (cookies.length > 0) {
      try {
        await this.context.addCookies(cookies);
      } catch (e) {
        console.warn("[Perplexity Web Browser] Failed to add some cookies:", e);
      }
    }

    this.initialized = true;
  }

  async chatCompletions(params: {
    conversationId?: string;
    message: string;
    model: string;
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>> {
    if (!this.page) {
      throw new Error("PerplexityWebClientBrowser not initialized");
    }

    const { conversationId, message } = params;
    console.log(
      `[Perplexity Web Browser] Sending request... conversationId=${conversationId ?? "(new)"} messageLen=${message.length}`,
    );

    // DOM simulation using Playwright native APIs (not page.evaluate for input).
    // Perplexity's /search API now returns HTML, not SSE, so we interact via DOM.
    const page = this.page;

    // Click "新建问题" (New Thread) to start a fresh search.
    // This is more reliable than navigating to home page.
    const newThreadBtn = await page.$(
      'button:has-text("新建问题"), button:has-text("New Thread"), a:has-text("新建问题"), a:has-text("New Thread")',
    );
    if (newThreadBtn) {
      await newThreadBtn.click();
      console.log("[Perplexity Web Browser] Clicked 'New Thread' button");
      await page.waitForTimeout(1500);
    } else {
      // Fallback: navigate to home page
      await page.goto("https://www.perplexity.ai/", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
    }

    // Find and focus the input
    const inputSel = 'div[contenteditable="true"], [role="textbox"], textarea';
    const inputHandle = await page.$(inputSel);
    if (!inputHandle) {
      throw new Error("Perplexity DOM: input not found");
    }
    await inputHandle.click();
    await page.waitForTimeout(300);

    // Clear any residual text, then type message
    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);
    await page.keyboard.type(message, { delay: 20 });
    await page.waitForTimeout(500);

    // Record URL before submit to detect navigation
    const urlBeforeSubmit = page.url();

    // Press Enter to submit
    await page.keyboard.press("Enter");
    console.log("[Perplexity Web Browser] DOM: typed message and pressed Enter");

    // Wait for URL to change (new search creates a new URL)
    try {
      await page.waitForURL(
        (url) =>
          url.href !== urlBeforeSubmit &&
          (url.pathname.startsWith("/search/") || url.pathname.startsWith("/c/")),
        { timeout: 15000 },
      );
      console.log("[Perplexity Web Browser] DOM: navigated to", page.url());
    } catch {
      console.log("[Perplexity Web Browser] DOM: no URL change after Enter, polling anyway");
    }

    // Poll for response content
    const maxWaitMs = 120_000;
    const pollInterval = 3000;
    let lastText = "";
    let stableCount = 0;

    for (let elapsed = 0; elapsed < maxWaitMs; elapsed += pollInterval) {
      await page.waitForTimeout(pollInterval);

      const text = await page.evaluate(() => {
        const clean = (t: string) => t.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
        // Perplexity answer selectors — prose class is the main answer container
        const selectors = [
          '[class*="prose"]',
          '[class*="break-words"][class*="font-sans"]',
          '[class*="markdown"]',
          '[class*="threadConten"] [class*="gap-y-sm"]',
        ];
        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          for (let i = els.length - 1; i >= 0; i--) {
            const t = clean((els[i] as HTMLElement).innerText ?? "");
            if (t.length >= 2) {
              return t;
            }
          }
        }
        return "";
      });

      if (text && text.length >= 2) {
        if (text !== lastText) {
          lastText = text;
          stableCount = 0;
        } else {
          stableCount++;
          if (stableCount >= 2) {
            break;
          }
        }
      }
    }

    if (!lastText) {
      throw new Error("Perplexity DOM: no response detected after submit");
    }

    console.log(`[Perplexity Web Browser] Got response: ${lastText.length} chars`);

    // Return a ReadableStream with SSE format that perplexity-web-stream.ts can parse
    const ssePayload = `data: ${JSON.stringify({ text: lastText })}\n\ndata: [DONE]\n\n`;
    const sseBytes = new TextEncoder().encode(ssePayload);

    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseBytes);
        controller.close();
      },
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

  async discoverModels(): Promise<ModelDefinitionConfig[]> {
    return [
      {
        id: "perplexity-web",
        name: "Perplexity (Sonar)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
      {
        id: "perplexity-pro",
        name: "Perplexity Pro",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ];
  }
}
