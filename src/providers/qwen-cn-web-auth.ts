import { chromium } from "playwright-core";

export interface QwenCNWebAuthResult {
  cookies: Array<{
    name: string;
    value: string;
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  }>;
  xsrfToken: string;
  userAgent: string;
  ut?: string;
}

export async function loginQwenCNWeb(params: {
  onProgress: (msg: string) => void;
  openUrl: (url: string) => Promise<boolean>;
}): Promise<QwenCNWebAuthResult> {
  const { onProgress } = params;

  onProgress("Connecting to Chrome debug port...");

  const cdpUrl = "http://127.0.0.1:9222";
  let browser;

  try {
    const response = await fetch(`${cdpUrl}/json/version`);
    const versionInfo = await response.json();
    const wsUrl = versionInfo.webSocketDebuggerUrl;

    browser = await chromium.connectOverCDP(wsUrl);
    const context = browser.contexts()[0];

    onProgress("Opening Qwen CN (qianwen.com)...");

    let page = context.pages().find((p) => p.url().includes("qianwen.com"));
    if (!page) {
      page = await context.newPage();
      await page.goto("https://www.qianwen.com/", { waitUntil: "domcontentloaded" });
    }

    // If already logged in, capture cookies and verify API access
    let capturedCookies: QwenCNWebAuthResult["cookies"] = [];
    let xsrfToken = "";
    let ut = "";

    // Check if already logged in
    const initialCookies = await context.cookies();
    const sessionCookie = initialCookies.find(
      (c) => c.name === "tongyi_sso_ticket" || c.name === "login_aliyunid_ticket",
    );

    if (sessionCookie) {
      onProgress("Already logged in. Verifying API access...");

      // Capture full cookie objects (with domain, path, httpOnly, secure, etc.)
      capturedCookies = initialCookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      }));

      // Get XSRF token from page
      try {
        const tokenFromPage = await page.evaluate(() => {
          const meta = document.querySelector('meta[name="x-xsrf-token"]');
          return meta?.getAttribute("content") || "";
        });
        xsrfToken = tokenFromPage;
      } catch {
        const xsrfCookie = initialCookies.find((c) => c.name === "XSRF-TOKEN");
        if (xsrfCookie) {
          xsrfToken = xsrfCookie.value;
        }
      }

      // Get user ID
      const utCookie = initialCookies.find((c) => c.name === "b-user-id");
      if (utCookie) {
        ut = utCookie.value;
      }

      // Test API access to verify credentials work
      try {
        const apiTest = await page.evaluate(async () => {
          const res = await fetch("https://chat2.qianwen.com/api/v2/chat", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "qwen-turbo",
              messages: [{ content: "test", mime_type: "text/plain", meta_data: {} }],
              session_id: "test",
              scene: "chat",
              biz_id: "ai_qwen",
            }),
            credentials: "include",
          });
          const text = await res.text();
          return { status: res.status, body: text.substring(0, 200) };
        });

        if (apiTest.status === 200) {
          onProgress("API access verified!");
        } else {
          // API may require signature (EX015) — cookies are still valid.
          onProgress("API signature test skipped (cookies captured).");
        }
      } catch (e) {
        console.log("[Qwen CN Auth] API test failed:", e);
      }
    }

    // If not logged in or API test failed, wait for user to login
    if (!sessionCookie || capturedCookies.length === 0) {
      onProgress("Waiting for login... Please login in the browser");

      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1000));

        const cookies = await context.cookies();
        const newSessionCookie = cookies.find(
          (c) => c.name === "tongyi_sso_ticket" || c.name === "login_aliyunid_ticket",
        );

        if (newSessionCookie) {
          // Capture full cookie objects for addCookies
          capturedCookies = cookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            expires: c.expires,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite,
          }));

          try {
            const tokenFromPage = await page.evaluate(() => {
              const meta = document.querySelector('meta[name="x-xsrf-token"]');
              return meta?.getAttribute("content") || "";
            });
            xsrfToken = tokenFromPage;
          } catch {
            const xsrfCookie = cookies.find((c) => c.name === "XSRF-TOKEN");
            if (xsrfCookie) {
              xsrfToken = xsrfCookie.value;
            }
          }

          const utCookie = cookies.find((c) => c.name === "b-user-id");
          if (utCookie) {
            ut = utCookie.value;
          }

          onProgress("Login detected! Verifying API access...");

          // Verify API access after login
          try {
            const apiTest = await page.evaluate(async () => {
              const res = await fetch("https://chat2.qianwen.com/api/v2/chat", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  model: "qwen-turbo",
                  messages: [{ content: "test", mime_type: "text/plain", meta_data: {} }],
                  session_id: "test",
                  scene: "chat",
                  biz_id: "ai_qwen",
                }),
                credentials: "include",
              });
              const text = await res.text();
              return { status: res.status, body: text.substring(0, 200) };
            });

            if (apiTest.status === 200) {
              onProgress("Login and API access verified!");
            } else {
              // API test may fail due to signature requirements (EX015),
              // but login is still valid — cookies are captured.
              onProgress("Login detected. API signature test skipped (cookies captured).");
            }
          } catch (e) {
            console.log("[Qwen CN Auth] API test failed:", e);
          }

          break;
        }

        if (i % 10 === 0) {
          onProgress(`Waiting for login... (${i}s)`);
        }
      }
    }

    if (capturedCookies.length === 0) {
      throw new Error("Login timeout. Please login within 2 minutes.");
    }

    const userAgent = await page.evaluate(() => navigator.userAgent);

    await browser.close();

    onProgress("Credentials captured successfully!");

    return {
      cookies: capturedCookies,
      xsrfToken,
      userAgent,
      ut,
    };
  } catch (error) {
    if (browser) {
      await browser.close();
    }
    throw error;
  }
}
