import { chromium, type BrowserContext, type Page } from "playwright-core";
import {
  getHeadersWithAuth,
  launchOpenClawChrome,
  stopOpenClawChrome,
  requireChromeWebSocketUrl,
} from "../lib/cdp.js";
import { resolveBrowserConfig, resolveProfile, loadConfig } from "../lib/browser-context.js";

const GROK_LOGIN_MAX_MS = 300_000;
const GROK_LOGIN_POLL_MS = 1_200;

const NOISE_COOKIE_NAMES = new Set([
  "__cf_bm",
  "_ga",
  "_gid",
  "_gat",
  "_gcl_au",
  "FPLC",
  "FPAU",
]);

function isNoiseCookieName(name: string): boolean {
  if (NOISE_COOKIE_NAMES.has(name)) {
    return true;
  }
  if (name.startsWith("_ga_") || name.startsWith("cf-")) {
    return true;
  }
  if (name.startsWith("_")) {
    return name.startsWith("_gcl_") || name === "_gclid";
  }
  return name.startsWith("__cf");
}

/** HttpOnly 会话 cookie 在页面里读不到，必须用 context.cookies。 */
function hasMeaningfulGrokSessionCookies(
  cookies: { name: string; value: string; domain: string }[],
): boolean {
  if (cookies.length === 0) {
    return false;
  }
  const meaningful = cookies.filter((c) => !isNoiseCookieName(c.name));
  if (meaningful.length === 0) {
    return false;
  }
  for (const c of meaningful) {
    const n = c.name.toLowerCase();
    if (n.length === 0) {
      continue;
    }
    if (
      n.includes("session") ||
      n.includes("auth") ||
      n.includes("token") ||
      n.includes("sso") ||
      n.includes("xai")
    ) {
      return true;
    }
  }
  return meaningful.some((c) => c.value.length >= 16);
}

async function pageLooksLikeGrokAuthedApp(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const t = (document.body?.innerText ?? "").toLowerCase();
    if (t.includes("log in to grok") || t.includes("sign in to continue") || t.includes("sign in with")) {
      return false;
    }
    if (t.includes("ask grok") || t.includes("new chat") || t.includes("start a conversation")) {
      return true;
    }
    const hasComposer =
      document.querySelector("textarea") !== null ||
      document.querySelector("[contenteditable='true']") !== null;
    return hasComposer;
  });
}

async function detectGrokLoginReady(page: Page, context: BrowserContext): Promise<boolean> {
  const forUrls = ["https://grok.com", "https://www.grok.com"];
  const all = await context.cookies(forUrls);
  if (hasMeaningfulGrokSessionCookies(all)) {
    return true;
  }
  if (page.url().includes("grok.com") && (await pageLooksLikeGrokAuthedApp(page))) {
    return true;
  }
  return false;
}

export interface GrokWebAuthResult {
  cookie: string;
  userAgent: string;
}

export interface GrokWebAuthOptions {
  onProgress?: (message: string) => void;
  openUrl?: (url: string) => Promise<boolean>;
}

export async function loginGrokWeb(options: GrokWebAuthOptions = {}): Promise<GrokWebAuthResult> {
  const { onProgress = console.log } = options;

  const rootConfig = loadConfig();
  const browserConfig = resolveBrowserConfig(rootConfig.browser, rootConfig);
  const profile = resolveProfile(browserConfig, browserConfig.defaultProfile);
  if (!profile) {
    throw new Error(`Could not resolve browser profile '${browserConfig.defaultProfile}'`);
  }

  let running: Awaited<ReturnType<typeof launchOpenClawChrome>> | { cdpPort: number };
  let didLaunch = false;

  if (browserConfig.attachOnly) {
    onProgress("Connecting to existing Chrome (attach mode)...");
    running = { cdpPort: profile.cdpPort };
  } else {
    onProgress("Launching browser...");
    running = await launchOpenClawChrome(browserConfig, profile);
    didLaunch = true;
  }

  try {
    const cdpUrl = browserConfig.attachOnly
      ? profile.cdpUrl
      : `http://127.0.0.1:${running.cdpPort}`;

    onProgress("Waiting for browser debugger (will retry if Chrome is still starting)...");
    const wsUrl = await requireChromeWebSocketUrl(cdpUrl);

    onProgress("Connecting to browser...");
    const browser = await chromium.connectOverCDP(wsUrl, {
      headers: getHeadersWithAuth(wsUrl),
    });
    const context = browser.contexts()[0];
    const page = context.pages()[0] || (await context.newPage());

    onProgress("Navigating to Grok...");
    await page.goto("https://grok.com", { waitUntil: "domcontentloaded" });

    const userAgent = await page.evaluate(() => navigator.userAgent);
    onProgress("Please login to Grok in the opened browser window...");
    onProgress(
      "Waiting for authentication (使用 HttpOnly Cookie 与页面检测，最长 " +
        `${GROK_LOGIN_MAX_MS / 1000}s)…`,
    );

    const deadline = Date.now() + GROK_LOGIN_MAX_MS;
    let sawLogin = false;
    while (Date.now() < deadline) {
      if (await detectGrokLoginReady(page, context)) {
        sawLogin = true;
        break;
      }
      await new Promise((r) => setTimeout(r, GROK_LOGIN_POLL_MS));
    }

    if (!sawLogin) {
      throw new Error(
        "在超时时间内未检测到 Grok 已登录。若页面已能聊天，可尝试在 grok.com 刷新后重试；" +
          "并确认本机用调试 Chrome（start-chrome-debug）登录的是与 CDP 绑定的同一用户配置。",
      );
    }

    onProgress("Login detected, capturing cookies...");
    const captured = await context.cookies(["https://grok.com", "https://www.grok.com"]);
    const byName = new Map<string, string>();
    for (const c of captured) {
      byName.set(c.name, c.value);
    }
    const cookieString = [...byName.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
    onProgress("Authentication captured successfully!");

    return { cookie: cookieString, userAgent };
  } finally {
    if (didLaunch && running && "proc" in running) {
      await stopOpenClawChrome(running);
    }
  }
}
