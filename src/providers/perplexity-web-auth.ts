import { chromium } from "playwright-core";
import {
  getHeadersWithAuth,
  launchOpenClawChrome,
  stopOpenClawChrome,
  requireChromeWebSocketUrl,
} from "../lib/cdp.js";
import { resolveBrowserConfig, resolveProfile, loadConfig } from "../lib/browser-context.js";

export interface PerplexityWebAuthResult {
  cookie: string;
  userAgent: string;
}

export interface PerplexityWebAuthOptions {
  onProgress?: (message: string) => void;
  openUrl?: (url: string) => Promise<boolean>;
  headless?: boolean;
}

export async function loginPerplexityWeb(
  options: PerplexityWebAuthOptions = {},
): Promise<PerplexityWebAuthResult> {
  const { onProgress = console.log, headless = false } = options;

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

    onProgress("Navigating to Perplexity...");
    await page.goto("https://www.perplexity.ai", { waitUntil: "domcontentloaded" });

    onProgress("Please login in the browser window...");
    onProgress("Waiting for authentication...");

    // Wait for login completion by checking for Perplexity auth cookies
    // __Secure-next-auth.session-token is standard, but sometimes it sets 'cf_clearance' or custom cookies.
    // A simpler way: wait until the login modal/overlay disappears, or checking URL change/cookie exist.
    await page.waitForFunction(
      () => {
        return (
          document.cookie.includes("__Secure-next-auth.session-token") ||
          document.cookie.includes("intercom_session") ||
          document.cookie.includes("perplexity_") ||
          document.cookie.includes("next-auth.session-token") ||
          (window.location.pathname === "/" &&
            !document.querySelector('button[data-testid="login-button"]'))
        );
      },
      { timeout: 300000 },
    );

    onProgress("Login detected, capturing cookies...");

    const cookies = await context.cookies();
    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const userAgent = await page.evaluate(() => navigator.userAgent);

    onProgress("Authentication captured successfully!");

    return {
      cookie: cookieString,
      userAgent,
    };
  } finally {
    if (didLaunch && running && "proc" in running) {
      await stopOpenClawChrome(running);
    }
  }
}
