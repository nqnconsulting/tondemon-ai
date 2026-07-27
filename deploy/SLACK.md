# Tondemon AI — Slack bot setup

Ask your live Anypoint estate questions from Slack: `@Tondemon how is my platform doing?`
or DM the bot `why aren't orders reaching Salesforce?`. The bot sends your question to
Claude with the Tondemon MCP server attached as a remote connector, Claude calls the live
read-only tools, and the answer comes back in-thread.

```
Slack  ──@mention/DM──▶  tondemon-slack container  ──Claude API──▶  Claude
                                                                      │
                              Tondemon MCP server  ◀──MCP connector───┘
                              (https://your-server.example.com/mcp)
```

Uses **Socket Mode** (an outbound WebSocket), so Slack needs no public URL and there's
nothing new to expose on the firewall.

---

## 1. Create the Slack app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. Name it `Tondemon` and pick your workspace.

## 2. Enable Socket Mode

- **Settings → Socket Mode** → toggle **Enable Socket Mode** on.
- When prompted, create an **App-Level Token** with the `connections:write` scope.
  Copy it — it starts with `xapp-`. This is `SLACK_APP_TOKEN`.

## 3. Bot scopes

- **Features → OAuth & Permissions → Scopes → Bot Token Scopes**, add:
  - `app_mentions:read`
  - `chat:write`
  - `im:history`
  - `reactions:write`

## 4. Subscribe to events

- **Features → Event Subscriptions** → toggle **Enable Events** on.
  (Socket Mode means you do **not** enter a Request URL.)
- Under **Subscribe to bot events**, add:
  - `app_mention`
  - `message.im`

## 5. Allow DMs (optional but nice)

- **Features → App Home → Show Tabs** → enable **Messages Tab** and check
  *"Allow users to send Slash commands and messages from the messages tab."*

## 6. Install

- **Settings → Install App** → **Install to Workspace** → Allow.
- Copy the **Bot User OAuth Token** (`xoxb-...`). This is `SLACK_BOT_TOKEN`.

---

## 7. Configure the server

On the server, add to `/opt/tondemon/.env`:

```ini
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
ANTHROPIC_API_KEY=sk-ant-...
TONDEMON_MCP_URL=https://your-server.example.com/mcp
TONDEMON_TOKEN=<same value as MCP_AUTH_TOKEN>
# ANTHROPIC_MODEL=claude-sonnet-4-6   # optional
```

> The bot needs an **Anthropic API key** (separate from a Claude.ai subscription) — it
> calls the Messages API to interpret questions and write answers. Each Slack question is
> one short Claude call plus the tool round-trips.

Then start the bridge:

```bash
cd /opt/tondemon
docker compose up -d --force-recreate slack   # NOT `restart` — that won't reload .env
docker compose logs -f slack                  # expect: "Socket Mode connected"
```

## 8. Use it

- In a channel: invite the bot (`/invite @Tondemon`), then `@Tondemon how is my platform doing?`
- Or just DM the bot directly.

Things to ask:

- `how is my platform doing?`
- `How is my cloudhub doing?`
- `why aren't orders reaching Salesforce?`
- `is the connection down on APIs that connect to the SMB server?`

Replies thread under your message; follow-ups in the same thread keep context.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `missing required env ...` in logs | A `SLACK_*` / `ANTHROPIC_API_KEY` / `TONDEMON_*` var is unset in `.env`. |
| Bot never responds in a channel | It must be **invited** to the channel, and `app_mention` event must be subscribed. |
| `not_authed` / `invalid_auth` | Re-copy the `xoxb-` (bot) and `xapp-` (app-level) tokens; reinstall if scopes changed. |
| `:warning: Couldn't reach Tondemon` | Check `TONDEMON_TOKEN` matches `MCP_AUTH_TOKEN` and `TONDEMON_MCP_URL` is reachable. |
| Answers ignore the live estate | Confirm the MCP server itself returns live data (`describe_source` → `kind:anypoint, access:ok`). |
