import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

// Minimal, spec-compliant OAuth 2.0 layer so account-level MCP connectors
// (ChatGPT / Codex app + phone, Claude web/phone) can authenticate — they
// require OAuth, not a static bearer token. Implements:
//   - RFC 9728 protected-resource metadata     (/.well-known/oauth-protected-resource)
//   - RFC 8414 authorization-server metadata    (/.well-known/oauth-authorization-server)
//   - RFC 7591 dynamic client registration      (/register)
//   - Authorization Code + PKCE (S256)          (/authorize, /token)
//   - refresh_token grant
// The /authorize step is gated by OAUTH_PASSCODE (a human-typable secret the
// owner enters once per device), so auto-discovery doesn't mean open access.
// Tokens live in memory: a server restart just forces a re-auth.

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const s256 = (v: string) => b64url(createHash("sha256").update(v).digest());
const rnd = (n = 32) => b64url(randomBytes(n));

interface Code { clientId: string; redirectUri: string; codeChallenge?: string; method?: string; exp: number }

const clients = new Map<string, { redirectUris: string[] }>();
const codes = new Map<string, Code>();
const accessTokens = new Map<string, { exp: number }>();
const refreshTokens = new Map<string, { clientId: string }>();

const TOKEN_TTL = 3600; // seconds
const CODE_TTL = 600;

export function isValidAccessToken(token: string): boolean {
  const t = accessTokens.get(token);
  if (!t) return false;
  if (t.exp < Date.now()) {
    accessTokens.delete(token);
    return false;
  }
  return true;
}

function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? "localhost";
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  return `${proto}://${host}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

async function readRaw(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const c of req) raw += c;
  return raw;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

function authorizePage(params: Record<string, string>, error?: string): string {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect Tondemon AI</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b0b0c;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#161618;padding:28px;border-radius:14px;max-width:340px;width:90%;box-shadow:0 8px 40px rgba(0,0,0,.5)}
h1{font-size:18px;margin:0 0 6px}p{color:#9a9aa2;font-size:13px;margin:0 0 18px;line-height:1.4}
input[type=password]{width:100%;padding:12px;border-radius:9px;border:1px solid #333;background:#0b0b0c;color:#eee;box-sizing:border-box;font-size:16px}
button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:9px;background:#4f7cff;color:#fff;font-size:15px;font-weight:600}
.err{color:#ff6b6b;font-size:13px;margin-top:10px}</style></head>
<body><form class="card" method="POST" action="/authorize">
<h1>🜂 Connect Tondemon AI</h1><p>Enter the access passcode to let this app query your integration estate (read-only).</p>
<input type="password" name="passcode" placeholder="Passcode" autofocus autocomplete="off">${hidden}
${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
<button type="submit">Authorize</button></form></body></html>`;
}

/** Returns true if it fully handled the request (OAuth endpoint); false otherwise. */
export async function handleOAuth(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const base = baseUrlOf(req);
  const url = new URL(req.url ?? "/", base);
  const path = url.pathname;

  if (req.method === "OPTIONS" && (path.startsWith("/.well-known") || ["/register", "/token", "/authorize"].includes(path))) {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    });
    res.end();
    return true;
  }

  // Protected-resource metadata (RFC 9728) — also matches the /mcp-suffixed variant.
  if (req.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
    sendJson(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ["header"], scopes_supported: ["mcp"] });
    return true;
  }

  // Authorization-server metadata (RFC 8414) + OIDC discovery alias.
  if (req.method === "GET" && (path.startsWith("/.well-known/oauth-authorization-server") || path === "/.well-known/openid-configuration")) {
    sendJson(res, 200, {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
    return true;
  }

  // Dynamic client registration (RFC 7591).
  if (req.method === "POST" && path === "/register") {
    let body: any = {};
    try {
      body = JSON.parse((await readRaw(req)) || "{}");
    } catch {
      /* tolerate empty/invalid */
    }
    const clientId = rnd(16);
    const redirectUris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    clients.set(clientId, { redirectUris });
    sendJson(res, 201, {
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_id_issued_at: Math.floor(Date.now() / 1000),
    });
    return true;
  }

  // Authorization endpoint — passcode-gated consent.
  if (path === "/authorize") {
    const passcode = process.env.OAUTH_PASSCODE ?? "";
    if (req.method === "GET") {
      const p = {
        client_id: url.searchParams.get("client_id") ?? "",
        redirect_uri: url.searchParams.get("redirect_uri") ?? "",
        state: url.searchParams.get("state") ?? "",
        code_challenge: url.searchParams.get("code_challenge") ?? "",
        code_challenge_method: url.searchParams.get("code_challenge_method") ?? "",
        scope: url.searchParams.get("scope") ?? "",
      };
      res.writeHead(200, { "content-type": "text/html" });
      res.end(authorizePage(p));
      return true;
    }
    if (req.method === "POST") {
      const form = new URLSearchParams(await readRaw(req));
      const redirectUri = form.get("redirect_uri") ?? "";
      const state = form.get("state") ?? "";
      const p = {
        client_id: form.get("client_id") ?? "",
        redirect_uri: redirectUri,
        state,
        code_challenge: form.get("code_challenge") ?? "",
        code_challenge_method: form.get("code_challenge_method") ?? "",
        scope: form.get("scope") ?? "",
      };
      if (!passcode || form.get("passcode") !== passcode) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(authorizePage(p, passcode ? "Incorrect passcode." : "Server passcode not configured."));
        return true;
      }
      const code = rnd(24);
      codes.set(code, {
        clientId: p.client_id,
        redirectUri,
        codeChallenge: p.code_challenge || undefined,
        method: p.code_challenge_method || undefined,
        exp: Date.now() + CODE_TTL * 1000,
      });
      const sep = redirectUri.includes("?") ? "&" : "?";
      const loc = `${redirectUri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ""}`;
      res.writeHead(302, { location: loc });
      res.end();
      return true;
    }
  }

  // Token endpoint.
  if (req.method === "POST" && path === "/token") {
    const ct = req.headers["content-type"] ?? "";
    const raw = await readRaw(req);
    const form = ct.includes("application/json")
      ? new URLSearchParams(Object.entries(JSON.parse(raw || "{}")).map(([k, v]) => [k, String(v)] as [string, string]))
      : new URLSearchParams(raw);
    const grant = form.get("grant_type");

    if (grant === "authorization_code") {
      const code = form.get("code") ?? "";
      const verifier = form.get("code_verifier") ?? "";
      const rec = codes.get(code);
      if (!rec || rec.exp < Date.now()) {
        sendJson(res, 400, { error: "invalid_grant" });
        return true;
      }
      if (rec.codeChallenge) {
        const ok = rec.method === "S256" ? s256(verifier) === rec.codeChallenge : verifier === rec.codeChallenge;
        if (!ok) {
          sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
          return true;
        }
      }
      codes.delete(code);
      const at = rnd(32);
      const rt = rnd(32);
      accessTokens.set(at, { exp: Date.now() + TOKEN_TTL * 1000 });
      refreshTokens.set(rt, { clientId: rec.clientId });
      sendJson(res, 200, { access_token: at, token_type: "Bearer", expires_in: TOKEN_TTL, refresh_token: rt, scope: "mcp" });
      return true;
    }

    if (grant === "refresh_token") {
      const rt = form.get("refresh_token") ?? "";
      if (!refreshTokens.has(rt)) {
        sendJson(res, 400, { error: "invalid_grant" });
        return true;
      }
      const at = rnd(32);
      accessTokens.set(at, { exp: Date.now() + TOKEN_TTL * 1000 });
      sendJson(res, 200, { access_token: at, token_type: "Bearer", expires_in: TOKEN_TTL, refresh_token: rt, scope: "mcp" });
      return true;
    }

    sendJson(res, 400, { error: "unsupported_grant_type" });
    return true;
  }

  return false;
}
