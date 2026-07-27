#!/usr/bin/env node
import bolt from "@slack/bolt";
import Anthropic from "@anthropic-ai/sdk";

import { SERVER_INSTRUCTIONS } from "./tools.js";

// Tondemon AI — Slack bridge
// ----------------------------------------------------------------------------
// Lets anyone in Slack ask plain-English questions about the live Anypoint
// estate ("how is my platform doing?", "why aren't orders reaching Salesforce?")
// by @mentioning the bot or DMing it.
//
// How it works:
//   Slack message  ->  Claude (Anthropic Messages API)  ->  Tondemon MCP server
//                                                            (remote MCP connector)
// Claude picks and calls the Tondemon tools (get_apis_health / diagnose /
// trace_transaction / ...) against THIS user's live estate, then we post the
// natural-language answer back in-thread.
//
// Transport: Slack Socket Mode (outbound WebSocket) — no public route or URL
// verification needed, so it runs as a plain container with no ports exposed.
//
// Required env:
//   SLACK_BOT_TOKEN     xoxb-...   (bot token; scopes: app_mentions:read, chat:write, im:history)
//   SLACK_APP_TOKEN     xapp-...   (app-level token with connections:write — enables Socket Mode)
//   ANTHROPIC_API_KEY   sk-ant-... (the bot calls Claude to interpret + answer)
//   TONDEMON_MCP_URL    https://your-server.example.com/mcp
//   TONDEMON_TOKEN      the MCP_AUTH_TOKEN bearer the MCP server expects
// Optional:
//   ANTHROPIC_MODEL     defaults to claude-sonnet-5
//   SLACK_MAX_TOKENS    defaults to 4096 (mcp_tool_use blocks count as output tokens)
//   SLACK_DEADLINE_MS   defaults to 240000 (4 min) — hard stop for one investigation

const { App } = bolt;

const BOT_TOKEN = requireEnv("SLACK_BOT_TOKEN");
const APP_TOKEN = requireEnv("SLACK_APP_TOKEN");
const ANTHROPIC_API_KEY = requireEnv("ANTHROPIC_API_KEY");
const MCP_URL = requireEnv("TONDEMON_MCP_URL");
const MCP_TOKEN = requireEnv("TONDEMON_TOKEN");
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const MAX_TOKENS = parseInt(process.env.SLACK_MAX_TOKENS || "4096", 10);
const DEADLINE = parseInt(process.env.SLACK_DEADLINE_MS || "240000", 10);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[tondemon-slack] missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

// maxRetries 1: with streaming, retries only fire on fast pre-first-byte
// failures — never a silent re-run of a whole multi-minute tool loop.
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY, maxRetries: 1 });

// All prompt text (diagnostic method + answer style, shared by every surface)
// lives in playbook/PLAYBOOK.md. The playbook has Slack-specific formatting
// rules ("when answering in Slack…"), so tell the model which surface this is.
const SYSTEM_PROMPT = `${SERVER_INSTRUCTIONS}\n\nYou are answering in Slack.`;

/** Ask Claude (with the Tondemon MCP connector) and return the text answer. */
async function ask(messages: Anthropic.Beta.Messages.BetaMessageParam[]): Promise<string> {
  const startedAt = Date.now();
  // Own deadline: the server-side MCP tool loop can run long; abort instead of
  // sitting silent until the SDK's HTTP timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE);

  let resp: Anthropic.Beta.Messages.BetaMessage;
  try {
    const stream = anthropic.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages,
        mcp_servers: [
          {
            type: "url",
            url: MCP_URL,
            name: "tondemon",
            authorization_token: MCP_TOKEN,
          },
        ],
        betas: ["mcp-client-2025-04-04"],
      },
      { signal: controller.signal },
    );
    resp = await stream.finalMessage();
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(
        `investigation ran past ${DEADLINE / 1000}s and was stopped — try a narrower question`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const toolCalls = resp.content.filter((b) => b.type === "mcp_tool_use").length;
  const u = resp.usage;
  console.error(
    `[tondemon-slack] answered in ${Math.round((Date.now() - startedAt) / 1000)}s: ` +
      `${toolCalls} tool calls, in=${u.input_tokens} (cache_read=${u.cache_read_input_tokens ?? 0}) ` +
      `out=${u.output_tokens}, stop=${resp.stop_reason}`,
  );

  let text = resp.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (resp.stop_reason === "max_tokens") {
    console.error(`[tondemon-slack] warning: hit max_tokens (${MAX_TOKENS}) — answer truncated`);
    text += "\n_(answer truncated — raise SLACK_MAX_TOKENS)_";
  }

  return text.trim() || "_(no answer — the model returned no text)_";
}

const app = new App({ token: BOT_TOKEN, appToken: APP_TOKEN, socketMode: true });

// Build conversation history from a Slack thread so follow-ups have context.
async function threadHistory(
  client: bolt.webApi.WebClient,
  channel: string,
  threadTs: string | undefined,
  botUserId: string,
): Promise<Anthropic.Beta.Messages.BetaMessageParam[]> {
  if (!threadTs) return [];
  try {
    const res = await client.conversations.replies({ channel, ts: threadTs, limit: 20 });
    const msgs = res.messages ?? [];
    return msgs
      .filter((m) => typeof m.text === "string" && m.text.trim())
      .map((m) => ({
        role: m.bot_id || m.user === botUserId ? ("assistant" as const) : ("user" as const),
        content: stripMention(m.text as string, botUserId),
      }))
      .filter((m) => m.content.trim().length > 0);
  } catch {
    return [];
  }
}

function stripMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
}

// Shared handler for @mentions and DMs.
async function handle(opts: {
  client: bolt.webApi.WebClient;
  channel: string;
  text: string;
  threadTs?: string;
  eventTs: string;
  botUserId: string;
  user?: string;
}): Promise<void> {
  const { client, channel, text, threadTs, eventTs, botUserId, user } = opts;
  const question = stripMention(text, botUserId);
  // Reply in-thread: use the existing thread, else start one on this message.
  const replyThread = threadTs || eventTs;

  if (!question) {
    await client.chat.postMessage({
      channel,
      thread_ts: replyThread,
      text: "Ask me about your Anypoint estate — e.g. *how is my platform doing?*, *why aren't orders reaching Salesforce?*, or *is the connection down on APIs that connect to the SMB server?*",
    });
    return;
  }

  console.error(
    `[tondemon-slack] question in ${channel} from ${user ?? "?"}: "${question.slice(0, 100)}"`,
  );

  // Acknowledge quickly so the user knows it's working.
  await client.reactions.add({ channel, timestamp: eventTs, name: "eyes" }).catch(() => {});

  try {
    const history = await threadHistory(client, channel, threadTs, botUserId);
    // Ensure the latest user turn is present (replies() may lag the live event).
    const messages = history.length ? history : [{ role: "user" as const, content: question }];
    if (messages[messages.length - 1]?.role !== "user") {
      messages.push({ role: "user", content: question });
    }
    const answer = await ask(messages);
    await client.chat.postMessage({ channel, thread_ts: replyThread, text: answer });
  } catch (err) {
    const msg = (err as Error).message || String(err);
    console.error("[tondemon-slack] error:", msg);
    await client.chat.postMessage({
      channel,
      thread_ts: replyThread,
      text: `:warning: Claude call failed: \`${msg}\``,
    });
  } finally {
    await client.reactions.remove({ channel, timestamp: eventTs, name: "eyes" }).catch(() => {});
  }
}

app.event("app_mention", async ({ event, client, context }) => {
  await handle({
    client,
    channel: event.channel,
    text: event.text ?? "",
    threadTs: (event as { thread_ts?: string }).thread_ts,
    eventTs: event.ts,
    botUserId: context.botUserId ?? "",
    user: (event as { user?: string }).user,
  });
});

// Direct messages to the bot.
app.message(async ({ message, client, context }) => {
  const m = message as {
    channel_type?: string;
    subtype?: string;
    bot_id?: string;
    text?: string;
    ts: string;
    thread_ts?: string;
    channel: string;
    user?: string;
  };
  if (m.channel_type !== "im") return; // only DMs; channels use @mention
  if (m.subtype || m.bot_id) return; // ignore edits/joins/bot echoes
  await handle({
    client,
    channel: m.channel,
    text: m.text ?? "",
    threadTs: m.thread_ts,
    eventTs: m.ts,
    botUserId: context.botUserId ?? "",
    user: m.user,
  });
});

(async () => {
  await app.start();
  console.error(
    `[tondemon-slack] Socket Mode connected. Model: ${MODEL}. MCP: ${MCP_URL}. ` +
      `@mention the bot in a channel or DM it.`,
  );
})();
