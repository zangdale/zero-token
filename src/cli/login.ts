import { setProviderCredential, resolveDataDir, credentialsPath } from "../credentials.js";

/** 所有可登录的 web-api id（与下方 providers 键一致）。 */
export const ALL_PROVIDER_IDS = [
  "deepseek-web",
  "claude-web",
  "chatgpt-web",
  "qwen-web",
  "qwen-cn-web",
  "kimi-web",
  "gemini-web",
  "grok-web",
  "glm-web",
  "glm-intl-web",
  "perplexity-web",
  "doubao-web",
  "xiaomimo-web",
] as const;

const providers: Record<string, () => Promise<string>> = {
  "deepseek-web": async () => {
    const m = await import("../providers/deepseek-web-auth.js");
    const r = await m.loginDeepseekWeb({
      onProgress: (msg) => console.log(msg),
      openUrl: async () => true,
    });
    return JSON.stringify({ cookie: r.cookie, bearer: r.bearer, userAgent: r.userAgent });
  },
  "claude-web": async () => {
    const m = await import("../providers/claude-web-auth.js");
    const r = await m.loginClaudeWeb({
      onProgress: (msg) => console.log(msg),
      openUrl: async () => true,
    });
    return JSON.stringify(r);
  },
  "chatgpt-web": async () => {
    const m = await import("../providers/chatgpt-web-auth.js");
    const r = await m.loginChatGPTWeb({
      onProgress: (msg) => console.log(msg),
      openUrl: async () => true,
    });
    return JSON.stringify(r);
  },
  "qwen-web": async () => {
    const m = await import("../providers/qwen-web-auth.js");
    const r = await m.loginQwenWeb({
      onProgress: (msg) => console.log(msg),
      openUrl: async () => true,
    });
    return JSON.stringify(r);
  },
  "qwen-cn-web": async () => {
    const m = await import("../providers/qwen-cn-web-auth.js");
    const r = await m.loginQwenCNWeb({
      onProgress: (msg) => console.log(msg),
      openUrl: async () => true,
    });
    return JSON.stringify(r);
  },
  "kimi-web": async () => {
    const m = await import("../providers/kimi-web-auth.js");
    const r = await m.loginKimiWeb({
      onProgress: (msg) => console.log(msg),
      openUrl: async () => true,
    });
    return JSON.stringify(r);
  },
  "gemini-web": async () => {
    const m = await import("../providers/gemini-web-auth.js");
    const r = await m.loginGeminiWeb({
      onProgress: (msg) => console.log(msg),
      openUrl: async () => true,
    });
    return JSON.stringify(r);
  },
  "grok-web": async () => {
    const m = await import("../providers/grok-web-auth.js");
    const r = await m.loginGrokWeb({
      onProgress: (msg) => console.log(msg),
      openUrl: async () => true,
    });
    return JSON.stringify(r);
  },
  "glm-web": async () => {
    const m = await import("../providers/glm-web-auth.js");
    const r = await m.loginZWeb({
      onProgress: (msg) => console.log(msg),
      openUrl: async () => true,
    });
    return JSON.stringify(r);
  },
  "glm-intl-web": async () => {
    const m = await import("../providers/glm-intl-web-auth.js");
    const r = await m.loginGlmIntlWeb({
      onProgress: (msg) => console.log(msg),
      openUrl: async () => true,
    });
    return JSON.stringify(r);
  },
  "perplexity-web": async () => {
    const m = await import("../providers/perplexity-web-auth.js");
    const r = await m.loginPerplexityWeb({
      onProgress: (msg) => console.log(msg),
      openUrl: async () => true,
    });
    return JSON.stringify(r);
  },
  "doubao-web": async () => {
    const m = await import("../providers/doubao-web-auth.js");
    const r = await m.loginDoubaoWeb({
      onProgress: (msg) => console.log(msg),
      openUrl: async () => true,
    });
    return JSON.stringify(r);
  },
  "xiaomimo-web": async () => {
    const m = await import("../providers/xiaomimo-web-auth.js");
    const r = await m.loginXiaomiMimoWeb({
      onProgress: (msg) => console.log(msg),
      openUrl: async () => true,
    });
    return JSON.stringify(r);
  },
};

function assertProvidersSync() {
  const keys = Object.keys(providers);
  if (keys.length !== ALL_PROVIDER_IDS.length) {
    throw new Error(
      `ALL_PROVIDER_IDS（${ALL_PROVIDER_IDS.length}）与 providers（${keys.length}）数量不一致`,
    );
  }
  for (const id of ALL_PROVIDER_IDS) {
    if (providers[id] === undefined) {
      throw new Error(`ALL_PROVIDER_IDS 与 providers 不一致: 缺少实现 ${id}`);
    }
  }
  const listed = new Set<string>([...ALL_PROVIDER_IDS]);
  for (const k of keys) {
    if (!listed.has(k)) {
      throw new Error(`providers 多出的键: ${k}，请补入 ALL_PROVIDER_IDS`);
    }
  }
}

async function loginAll(): Promise<number> {
  assertProvidersSync();
  const failed: string[] = [];
  const ok: string[] = [];
  console.log(
    `\n========== 全平台顺序登录（共 ${ALL_PROVIDER_IDS.length} 个）==========\n` +
      "若某站未在浏览器中完成操作，该条会失败并继续下一条；请提前用远程调试 Chrome 打开对应站点并尽量保持可登录状态。\n",
  );
  for (const id of ALL_PROVIDER_IDS) {
    const run = providers[id];
    console.log(`\n--- [${id}] ---`);
    try {
      const cred = await run();
      setProviderCredential(id, cred);
      ok.push(id);
      console.log(`[${id}] 已保存`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[${id}] 失败: ${msg}`);
      failed.push(id);
    }
  }
  const path = credentialsPath();
  console.log(
    `\n========== 完成 ==========\n` +
      `成功: ${ok.length} 个 ${ok.length ? `(${ok.join(", ")})` : ""}\n` +
      `失败: ${failed.length} 个 ${failed.length ? `(${failed.join(", ")})` : ""}\n` +
      `凭据文件: ${path}\n`,
  );
  return failed.length > 0 ? 1 : 0;
}

function firstCliArg(): string {
  // pnpm/npm `run script -- foo` 会在子进程里再插入一个 `--`（见实际命令: node ... login.ts -- foo）
  const args = process.argv.slice(2);
  while (args[0] === "--") {
    args.shift();
  }
  return (args[0] || "").trim();
}

async function main() {
  const p = firstCliArg();
  if (!p || p === "-h" || p === "--help") {
    console.log(`Usage: npx tsx src/cli/login.ts <web-api|all>\n`);
    console.log(`  all              按顺序尝试登录全部平台（单站失败不中断）`);
    console.log(`  Data directory: ${resolveDataDir()}`);
    console.log(`  Credentials: ${credentialsPath()}\n`);
    console.log("  BROWSER_CDP_URL: Chrome CDP, default http://127.0.0.1:9222");
    console.log("  (Start Chrome: google-chrome --remote-debugging-port=9222)\n");
    console.log("Providers:", Object.keys(providers).sort().join(", "));
    process.exit(p ? 1 : 0);
  }
  if (p === "all" || p === "login-all") {
    const code = await loginAll();
    process.exit(code);
  }
  const run = providers[p];
  if (!run) {
    console.error("Unknown provider:", p);
    process.exit(1);
  }
  console.log("Acquiring session for", p, "...");
  const cred = await run();
  setProviderCredential(p, cred);
  console.log("Saved to", credentialsPath());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
