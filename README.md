# zero-token

免 API Token 使用大模型 - 通过浏览器登录方式免费使用 ChatGPT、Claude、Gemini、DeepSeek、千问国际版、千问国内版、豆包、Kimi、智谱清言、Grok、小米 MiMo、Manus 等 AI 模型。

本项目通过**已开启远程调试的 Chrome** 完成各平台 Web 登录、保存会话，并对外提供 **OpenAI 兼容的 HTTP 接口**（`GET /v1/models`、`POST /v1/chat/completions`）。

## 支持的 Web 平台

首句为能力概述；**实际已接入、可登录的 Web 站点**以下表为准（与 `src/cli/login.ts` 中 `ALL_PROVIDER_IDS` 一致，当前共 13 个）。登录时把 `<id>` 传给 `pnpm run login -- <id>` 或 `make login PROVIDER=<id>`。

| 平台（常用名） | 提供方 `id` |
|----------------|-------------|
| ChatGPT | `chatgpt-web` |
| Claude | `claude-web` |
| Gemini | `gemini-web` |
| DeepSeek | `deepseek-web` |
| 千问（国际版） | `qwen-web` |
| 千问（国内版） | `qwen-cn-web` |
| Kimi | `kimi-web` |
| Grok | `grok-web` |
| 智谱清言（国内） | `glm-web` |
| 智谱清言（国际） | `glm-intl-web` |
| Perplexity（网页） | `perplexity-web` |
| 豆包 | `doubao-web` |
| 小米 MiMo | `xiaomimo-web` |

## 参考仓库

本项目的提供方桥接、浏览器 CDP 等实现与 [openclaw-zero-token](https://github.com/linuxhsj/openclaw-zero-token) 同源思路：该仓库为含 **OpenClaw 插件边界** 的完整树；**zero-token** 则抽成独立网关，仅保留凭据聚合与 OpenAI 兼容层，便于在无 OpenClaw 进程时单独部署。上游更新、issue 与讨论也可参考该 GitHub 项目。

## 要求

- **Node.js** ≥ 20
- **pnpm**（[安装](https://pnpm.io/installation)）；本仓库用 `packageManager` 固定版本，可用 [Corepack](https://nodejs.org/api/corepack.html)：`corepack enable`
- 本机可运行的 **Google Chrome / Chromium**（用于登录与部分「聊天走浏览器」路径）
- 启动 Chrome 时打开远程调试，例如：

  ```bash
  /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
  ```

  默认用 `BROWSER_CDP_URL=http://127.0.0.1:9222` 连接；可通过环境变量修改。

## 快速开始

```bash
git clone https://github.com/linuxhsj/zero-token.git
cd zero-token
make install
make chrome-debug
make login-all
PORT=3001 make start
```

在**已开远程调试**的 Chrome 中打开目标站点并登录，然后执行（以 `chatgpt-web` 为例）：

```bash
make login PROVIDER=chatgpt-web
```

凭据默认写入 `~/.zero-token/credentials.json`（可用 `ZERO_TOKEN_DATA_DIR` 改目录）。

启动网关：

```bash
make start
# 或指定端口
PORT=3001 make start
```

健康检查：

```bash
make health
```

### 不使用 `make` 时

Makefile 只是对 `pnpm` / 脚本的薄封装，可直接用等价命令：

| `make` 用法 | 等价命令 |
|-------------|----------|
| `make install` | `pnpm install` |
| `make start` | `PORT=3000 pnpm start`（端口可用环境变量 `PORT` 覆盖，如 `PORT=3001 pnpm start`） |
| `make login PROVIDER=<id>` | `pnpm run login -- <id>` |
| `make login-all` | `pnpm run login -- all` |
| `make typecheck` | `pnpm run typecheck` |
| `make health` | `curl -sS "http://127.0.0.1:${PORT:-3000}/health"`（需服务已启动） |
| `make chrome-debug` | `bash scripts/start-chrome-debug.sh`（可用 `CHROME_DEBUG_PORT`、`CHROME_USER_DATA_DIR` 覆盖默认调试端口与用户目录） |

也可在项目根目录用与脚本相同入口：`node --import tsx src/cli/login.ts <id|all>`、`node --import tsx src/server.ts`（启动前建议仍通过 `pnpm install` 安装依赖）。

### 全平台顺序登录

依次尝试登录**全部**已支持的 Web 提供方（与上表及 `ALL_PROVIDER_IDS` 一致，当前共 13 个）。**每个站点仍需你在浏览器中完成该站的登录/授权流程**；某一站失败会记录错误并继续下一站，结束时会打印成功/失败汇总。

```bash
make login-all
# 等价: pnpm run login -- all
```

## Makefile 目标

| 目标        | 说明 |
|------------|------|
| `make` / `make help` | 打印帮助 |
| `make install` | `pnpm install` |
| `make start` | 启动服务；`PORT` 默认 `3000` |
| `make login PROVIDER=<id>` | 运行浏览器登录；`<id>` 为 `src/cli/login.ts` 中列出的提供方（如 `deepseek-web`、`chatgpt-web`） |
| `make login-all` | 按顺序执行全部提供方登录，单站失败不中断 |
| `make typecheck` | `tsc --noEmit` |
| `make health` | 请求 `http://127.0.0.1:$PORT/health`（可设 `PORT`） |
| `make clean` | 删除 `node_modules` 与 `pnpm-lock.yaml` |

## 环境变量（节选）

| 变量 | 说明 |
|------|------|
| `PORT` | 网关监听端口，默认 `3000` |
| `BROWSER_CDP_URL` | Chrome 调试端点，默认 `http://127.0.0.1:9222` |
| `ZERO_TOKEN_DATA_DIR` | 数据目录（含 `credentials.json`），默认 `~/.zero-token` |
| `ZERO_TOKEN_API_KEY` | 若设置，请求需带 `Authorization: Bearer <key>` |
| `ZERO_TOKEN_CHAT_VIA_BROWSER` | 对 `chatgpt-web` / `gemini-web` / `grok-web`：设为 `0` 时关闭「聊天走真实页面 DOM」路径，仍用 Node 内流式实现 |

## OpenAI 兼容接口

服务默认监听 `http://127.0.0.1:3000`（可用 `PORT` 修改）。以下路径与 [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat/create) 用法一致，便于用任意支持自定义 `baseURL` 的客户端接入。

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查（不要求鉴权） |
| `GET` | `/v1/models` | 模型列表，返回的 `id` 即为下方 `model` 字段可用值 |
| `POST` | `/v1/chat/completions` | 聊天补全，支持流式（SSE）与非流式 JSON |

**鉴权**：若设置了环境变量 `ZERO_TOKEN_API_KEY`，则请求需带 `Authorization: Bearer <与之一致的密钥>`，否则返回 `401`。

**模型 id**：必须为 `提供方/模型` 形式（与 `GET /v1/models` 中每条 `id` 一致），例如 `grok-web/grok-2`、`chatgpt-web/gpt-4`、`deepseek-web/deepseek-chat`。

**非流式**（`stream` 省略或 `false`）：

```bash
curl -sS "http://127.0.0.1:3000/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ZERO_TOKEN_API_KEY" \
  -d '{
    "model": "grok-web/grok-2",
    "messages": [{ "role": "user", "content": "你好" }]
  }'
```

未设置 `ZERO_TOKEN_API_KEY` 时可去掉 `Authorization` 行。

**流式**（`"stream": true`，响应为 [SSE](https://developer.mozilla.org/docs/Web/API/Server-sent_events/Using_server-sent_events)，`data: {...}` 行后接 `data: [DONE]`）：

```bash
curl -N -sS "http://127.0.0.1:3000/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ZERO_TOKEN_API_KEY" \
  -d '{
    "model": "grok-web/grok-2",
    "messages": [{ "role": "user", "content": "你好" }],
    "stream": true
  }'
```

**拉取模型列表**：

```bash
curl -sS "http://127.0.0.1:3000/v1/models" \
  -H "Authorization: Bearer $ZERO_TOKEN_API_KEY" | jq .
```

**在代码里用 OpenAI 官方 SDK 指向本机**（将 `apiKey` 与网关侧 `ZERO_TOKEN_API_KEY` 对齐；若未设网关密钥可填任意非空字符串，以通过客户端校验。需安装 SDK：`pnpm add openai`）：

```ts
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.ZERO_TOKEN_API_KEY ?? "unused",
  baseURL: "http://127.0.0.1:3000/v1",
});

const r = await openai.chat.completions.create({
  model: "grok-web/grok-2",
  messages: [{ role: "user", content: "你好" }],
});
```

其它兼容 OpenAI 的 CLI/应用（如部分 IDE 插件、LiteLLM 等）在配置中把 **Base URL** 填为 `http://127.0.0.1:3000/v1` 即可，模型名使用 `GET /v1/models` 返回的 `id`。

## 开发

```bash
make typecheck
# 等价: pnpm run typecheck
```

## 许可

以 [MIT License](LICENSE) 发布。上游或自研扩展若再分发，请同时遵守其各自许可证。
