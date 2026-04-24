import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { stream as honoStream } from "hono/streaming";
import { resolveDataDir } from "./credentials.js";
import { listOpenAIModels } from "./catalog.js";
import {
  ChatGatewayError,
  collectNonStreamingText,
  formatSseData,
  openAIStreamingChunks,
  runChatCompletion,
} from "./gateway/chat.js";

const app = new Hono();

function checkApiKey(c: { req: { header: (n: string) => string | undefined } }) {
  const need = process.env.ZERO_TOKEN_API_KEY?.trim();
  if (!need) {
    return true;
  }
  const auth = c.req.header("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const key = m?.[1]?.trim();
  return key === need;
}

app.get("/health", (c) => c.json({ ok: true, dataDir: resolveDataDir() }));

app.get("/v1/models", async (c) => {
  if (!checkApiKey(c)) {
    return c.json({ error: { message: "Unauthorized" } }, 401);
  }
  const data = await listOpenAIModels();
  return c.json({ object: "list", data });
});

app.post("/v1/chat/completions", async (c) => {
  if (!checkApiKey(c)) {
    return c.json({ error: { message: "Unauthorized" } }, 401);
  }
  let body: {
    model?: string;
    messages?: unknown[];
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: { message: "Invalid JSON" } }, 400);
  }
  if (!body.model || !Array.isArray(body.messages)) {
    return c.json({ error: { message: "model and messages are required" } }, 400);
  }
  const streamMode = body.stream === true;
  try {
    const { stream: eventStream, webApi, modelId } = await runChatCompletion(
      {
        model: body.model,
        messages: body.messages as never,
        stream: streamMode,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
      },
      c.req.raw.signal,
    );
    if (streamMode) {
      const id = "chatcmpl-" + randomId();
      return honoStream(c, async (s) => {
        for await (const chunk of openAIStreamingChunks(eventStream, { id, webApi, modelId })) {
          await s.write(formatSseData(chunk));
        }
        await s.write("data: [DONE]\n\n");
      });
    }
    const json = await collectNonStreamingText(eventStream, { webApi, modelId });
    return c.json(json);
  } catch (e) {
    if (e instanceof ChatGatewayError) {
      return c.json({ error: { message: e.message } }, e.status as never);
    }
    return c.json({ error: { message: String(e) } }, 500);
  }
});

function randomId() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

const port = Number(process.env.PORT || "3000");
console.log(
  `zero-token gateway: http://127.0.0.1:${port}  (data: ${resolveDataDir()} ; set ZERO_TOKEN_API_KEY to require auth)`,
);
serve({ fetch: app.fetch, port });
