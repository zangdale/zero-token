import { isLoopbackHost } from "./net-loopback.js";

const DEFAULT_TIMEOUT = 10_000;

/**
 * If URL is already ws/wss, return as-is. Otherwise call Chrome /json/version over HTTP.
 */
export async function getChromeWebSocketUrl(
  cdpUrl: string,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<string | null> {
  const u = cdpUrl.trim();
  if (u.startsWith("ws://") || u.startsWith("wss://")) {
    return u;
  }
  const base = u.replace(/\/$/, "");
  const versionUrl = base.includes("/json/")
    ? `${base.split("/json")[0]}/json/version`
    : `${base}/json/version`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), Math.max(500, timeoutMs));
  try {
    const res = await fetch(versionUrl, { signal: ac.signal });
    if (!res.ok) {
      return null;
    }
    const j = (await res.json()) as { webSocketDebuggerUrl?: string };
    const raw = String(j.webSocketDebuggerUrl ?? "").trim();
    if (!raw) {
      return null;
    }
    return normalizeCdpWsUrl(raw, cdpUrl);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * 当无法连上本地 Chrome 远程调试时，在日志中打印的可读说明（供 login / 各 web-auth 使用）。
 */
export function formatChromeCdpConnectionError(cdpUrl: string): string {
  let port = "9222";
  try {
    const p = new URL(cdpUrl).port;
    if (p) {
      port = p;
    }
  } catch {
    // ignore
  }
  const base = cdpUrl.replace(/\/$/, "");
  return (
    `无法连接 Chrome 远程调试端点: ${cdpUrl}\n\n` +
    `本工具依赖「已开启 --remote-debugging-port 的 Chrome」，且 Node 能访问 \`${base}/json/version\`。\n\n` +
    `常见处理：\n` +
    `1) 先启动带调试端口的 Chrome，例如 (macOS)：\n` +
    `   open -a "Google Chrome" --args --remote-debugging-port=${port} ` +
    `  --user-data-dir="$HOME/.zero-token/chrome-debug-profile"\n` +
    `2) 或执行仓库脚本：\n` +
    `   ./scripts/start-chrome-debug.sh\n` +
    `3) 环境变量 BROWSER_CDP_URL 的端口需与上一步一致（默认 http://127.0.0.1:9222）。\n` +
    `4) 本机自检：\n` +
    `   curl -sS "${base}/json/version" | head -c 300\n` +
    `5) 仍失败时：关占用该端口的进程，或换端口并同时修改 BROWSER_CDP_URL。\n\n` +
    `可调环境变量：BROWSER_CDP_MAX_ATTEMPTS（默认 30）、BROWSER_CDP_RETRY_DELAY_MS（默认 1000）、` +
    `BROWSER_CDP_PER_TRY_TIMEOUT_MS（默认 3000）`
  );
}

/**
 * 在若干次重试后仍连不上则抛错（错误信息含 `formatChromeCdpConnectionError`），避免 Chrome 刚启动时只试 5s 就失败。
 */
export async function requireChromeWebSocketUrl(cdpUrl: string): Promise<string> {
  const maxAttempts = Math.max(
    1,
    Number.parseInt(process.env.BROWSER_CDP_MAX_ATTEMPTS || "30", 10) || 30,
  );
  const delayMs = Math.max(
    100,
    Number.parseInt(process.env.BROWSER_CDP_RETRY_DELAY_MS || "1000", 10) || 1000,
  );
  const perTryTimeout = Math.max(
    500,
    Number.parseInt(process.env.BROWSER_CDP_PER_TRY_TIMEOUT_MS || "3000", 10) || 3000,
  );
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    const ws = await getChromeWebSocketUrl(cdpUrl, perTryTimeout);
    if (ws) {
      return ws;
    }
  }
  throw new Error(formatChromeCdpConnectionError(cdpUrl));
}

export function normalizeCdpWsUrl(wsUrl: string, cdpUrl: string): string {
  const ws = new URL(wsUrl);
  const cdp = new URL(cdpUrl);
  const isWildcardBind = ws.hostname === "0.0.0.0" || ws.hostname === "[::]";
  if ((isLoopbackHost(ws.hostname) || isWildcardBind) && !isLoopbackHost(cdp.hostname)) {
    ws.hostname = cdp.hostname;
    const cdpPort = cdp.port || (cdp.protocol === "https:" ? "443" : "80");
    if (cdpPort) {
      ws.port = cdpPort;
    }
    ws.protocol = cdp.protocol === "https:" ? "wss:" : "ws:";
  }
  if (cdp.protocol === "https:" && ws.protocol === "ws:") {
    ws.protocol = "wss:";
  }
  if (!ws.username && !ws.password && (cdp.username || cdp.password)) {
    ws.username = cdp.username;
    ws.password = cdp.password;
  }
  for (const [key, value] of cdp.searchParams.entries()) {
    if (!ws.searchParams.has(key)) {
      ws.searchParams.append(key, value);
    }
  }
  return ws.toString();
}

export function getHeadersWithAuth(url: string, headers: Record<string, string> = {}) {
  const mergedHeaders = { ...headers };
  try {
    const parsed = new URL(url);
    const hasAuthHeader = Object.keys(mergedHeaders).some(
      (key) => key.toLowerCase() === "authorization",
    );
    if (hasAuthHeader) {
      return mergedHeaders;
    }
    if (parsed.username || parsed.password) {
      const auth = Buffer.from(`${parsed.username}:${parsed.password}`).toString("base64");
      return { ...mergedHeaders, Authorization: `Basic ${auth}` };
    }
  } catch {
    // ignore
  }
  return mergedHeaders;
}

/** Stub: this gateway expects an existing Chrome with --remote-debugging-port (attach mode). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function launchOpenClawChrome(
  _resolved?: unknown,
  _profile?: unknown,
  _opts?: unknown,
): Promise<{
  cdpPort: number;
  proc: { kill: () => void };
}> {
  throw new Error(
    "Auto-launch is disabled in zero-token gateway. Start Chrome with remote debugging, e.g. " +
      "google-chrome --remote-debugging-port=9222, then set BROWSER_CDP_URL (default http://127.0.0.1:9222) " +
      "and keep browser.attachOnly behavior.",
  );
}

export type RunningChromeLike = {
  cdpPort?: number;
  proc?: { killed?: boolean; kill: (signal?: NodeJS.Signals) => void } | unknown;
};

export async function stopOpenClawChrome(_running?: RunningChromeLike | null): Promise<void> {
  const proc =
    _running && typeof _running === "object" && "proc" in _running
      ? (_running as { proc?: { killed?: boolean; kill: (s?: NodeJS.Signals) => void } }).proc
      : null;
  if (!proc || typeof proc !== "object" || typeof proc.kill !== "function" || proc.killed) {
    return;
  }
  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }
}

export async function isChromeReachable(cdpUrl: string, timeoutMs = 3000): Promise<boolean> {
  const ws = await getChromeWebSocketUrl(cdpUrl, timeoutMs);
  return Boolean(ws);
}

export { isLoopbackHost } from "./net-loopback.js";
