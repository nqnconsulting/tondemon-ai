# Deploying TondemonAI to your own VPS

Docker Compose plus **Caddy** for automatic HTTPS. The result: a permanent
`https://<your-domain>/mcp` endpoint that Claude, Agentforce, or any MCP client can reach, so a
whole team shares one instance instead of each running it locally.

Everything below is manual and takes about ten minutes. If you want it automated, wiring a CD
workflow that builds the image and ships it over SSH is straightforward — the secrets table below
lists what such a workflow would need.

## One-time server setup
1. **Create a Linux VPS** — 2 vCPU / 4 GB is plenty for the server (more if you
   later self-host a local model). Ubuntu 24.04.
2. **Install Docker + compose plugin:**
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
3. **Create a deploy user + SSH key** (or reuse root). Put the deploy **public** key in the server's
   `~/.ssh/authorized_keys`; the matching **private** key goes into the GitHub secret `SSH_PRIVATE_KEY`.
4. **Create the app dir + env file:**
   ```bash
   mkdir -p /opt/tondemon
   # copy deploy/.env.example → /opt/tondemon/.env and fill it in:
   #   DOMAIN, MCP_AUTH_TOKEN (openssl rand -hex 32), and ONE source (Anypoint / MULE_LOG_DIR / demo)
   ```
5. **Point DNS** — an `A` record for `DOMAIN` → the server's IP (so Caddy can issue a TLS cert).
6. **Open ports 80 + 443** in your provider's firewall.

## Deploy

Copy `deploy/docker-compose.yml`, `deploy/Caddyfile` and your filled-in `.env` to
`/opt/tondemon` on the server, then:

```bash
cd /opt/tondemon && docker compose up -d --build
docker compose logs -f          # watch the first boot
```

Caddy fetches a Let's Encrypt certificate automatically on first run, once the DNS record from
step 5 resolves.

To redeploy after a change, rebuild and restart the same way. If you later automate this with a
CD workflow, these are the secrets it would need:

| Secret | Value |
|--------|-------|
| `DEPLOY_HOST` | server IP or hostname |
| `DEPLOY_USER` | ssh user (e.g. `deploy` or `root`) |
| `SSH_PRIVATE_KEY` | the deploy key's private half |

## Verify
```bash
curl https://<DOMAIN>/healthz                      # {"status":"ok",...}
curl -X POST https://<DOMAIN>/mcp \
  -H "authorization: Bearer <MCP_AUTH_TOKEN>" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}'
```
Then point an agent at `https://<DOMAIN>/mcp` with the bearer token (Claude, Agentforce registry, etc.).

## Notes
- **Secrets never touch CI** — they live only in `/opt/tondemon/.env` on the server. CI only needs SSH.
- **Rollback:** keep the previous `image.tar`; `docker load` it and `docker compose up -d` to revert.
- **No domain yet?** Edit the `Caddyfile` to the `:80` block for token-guarded plain HTTP (demo only),
  or put the server behind a tunnel.
