import { chromium } from "playwright-core";
import {
  getHeadersWithAuth,
  launchOpenClawChrome,
  stopOpenClawChrome,
  requireChromeWebSocketUrl,
} from "../lib/cdp.js";
import { resolveBrowserConfig, resolveProfile, loadConfig } from "../lib/browser-context.js";

export interface ZWebAuthResult {
  cookie: string;
  userAgent: string;
}

export interface ZWebAuthOptions {
  onProgress?: (message: string) => void;
  openUrl?: (url: string) => Promise<boolean>;
  headless?: boolean;
}

export async function loginZWeb(options: ZWebAuthOptions = {}): Promise<ZWebAuthResult> {
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

    onProgress("Navigating to ChatGLM...");
    await page.goto("https://chatglm.cn", { waitUntil: "domcontentloaded" });

    const userAgent = await page.evaluate(() => navigator.userAgent);
    onProgress("Please login to ChatGLM (智谱清言) in the opened browser window...");
    onProgress("Waiting for authentication (chatglm_refresh_token cookie)...");

    // Wait for the chatglm_refresh_token cookie which indicates successful login
    await page.waitForFunction(
      () => {
        return document.cookie.includes("chatglm_refresh_token");
      },
      { timeout: 300000 }, // 5 minutes
    );

    onProgress("Login detected, capturing cookies...");
    const cookies = await context.cookies("https://chatglm.cn");
    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    onProgress("Authentication captured successfully!");

    return { cookie: cookieString, userAgent };
  } finally {
    if (didLaunch && running && "proc" in running) {
      await stopOpenClawChrome(running);
    }
  }
}
