import { chromium } from "playwright-core";
import {
  getHeadersWithAuth,
  launchOpenClawChrome,
  stopOpenClawChrome,
  requireChromeWebSocketUrl,
} from "../lib/cdp.js";
import { resolveBrowserConfig, resolveProfile, loadConfig } from "../lib/browser-context.js";

export interface KimiWebAuthResult {
  cookie: string;
  accessToken?: string;
  refreshToken?: string;
  userAgent: string;
}

export interface KimiWebAuthOptions {
  onProgress?: (message: string) => void;
  openUrl?: (url: string) => Promise<boolean>;
}

/**
 * Kimi 自动登录：与 Claude/Doubao 一致，使用 OpenClaw 的系统 Chrome，
 * 不依赖 Playwright 下载的 bundled Chromium（无需 npx playwright install）
 */
export async function loginKimiWeb(options: KimiWebAuthOptions = {}): Promise<KimiWebAuthResult> {
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

    onProgress("Navigating to Kimi...");
    await page.goto("https://www.kimi.com/", { waitUntil: "domcontentloaded" });

    onProgress("Please login in the browser window...");
    onProgress("Waiting for authentication...");

    await page.waitForFunction(
      () => {
        return document.cookie.includes("access_token") || !!localStorage.getItem("access_token");
      },
      { timeout: 300000 }, // 5 minutes
    );

    onProgress("Login detected, capturing credentials...");

    // Also grab access_token from localStorage — some Kimi sessions use this
    // instead of (or alongside) the kimi-auth cookie
    const cookies = await context.cookies();
    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const localStorageData = await page.evaluate(() => {
      const at = localStorage.getItem("access_token");
      const rt = localStorage.getItem("refresh_token");
      const kimiAuth = document.cookie.includes("kimi-auth")
        ? (document.cookie
            .split(";")
            .find((c) => c.trim().startsWith("kimi-auth="))
            ?.split("=")[1] ?? "")
        : "";
      return { access_token: at, refresh_token: rt, kimiAuthCookie: kimiAuth };
    });
    const userAgent = await page.evaluate(() => navigator.userAgent);

    onProgress("Authentication captured successfully!");

    return {
      cookie: cookieString || `kimi-auth=${localStorageData.kimiAuthCookie}`,
      accessToken: localStorageData.access_token || undefined,
      refreshToken: localStorageData.refresh_token || undefined,
      userAgent,
    };
  } finally {
    if (didLaunch && running && "proc" in running) {
      await stopOpenClawChrome(running);
    }
  }
}
