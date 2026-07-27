import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { registerTools, SERVER_INSTRUCTIONS } from "./tools.js";
import { getActiveSource } from "./sources/index.js";
import { handleOAuth, isValidAccessToken } from "./oauth.js";

// HTTP (Streamable HTTP) transport — so the server can be deployed to a host
// and reached over the network, not just spawned locally over stdio.
//
// Design:
//  - ONE shared Source for the process (keeps the Anypoint token + log caches
//    warm across requests).
//  - STATELESS request handling: a fresh McpServer + transport per POST, so
//    there are no session leaks and it scales horizontally behind a proxy.
//  - Bearer-token auth guard (MCP_AUTH_TOKEN). An MCP endpoint reaches your
//    platform, so do not run it open in production.

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return undefined;
  return JSON.parse(raw);
}

export async function startHttp(port: number): Promise<void> {
  const source = getActiveSource();
  const authToken = process.env.MCP_AUTH_TOKEN;
  const desc = await Promise.resolve(source.describe()).catch((e) => ({ error: (e as Error).message }));

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // Liveness probe for the reverse proxy / CI smoke test.
      if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", server: "integration-monitor" }));
        return;
      }

      // OAuth discovery / registration / authorize / token endpoints.
      if (await handleOAuth(req, res)) return;

      if (req.url?.split("?")[0] !== "/mcp") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      // Auth guard — accept the static MCP_AUTH_TOKEN (CLI / mcp-remote) OR an
      // OAuth access token (account connectors / phone). 401 points clients at
      // the OAuth discovery document so they can start the flow.
      const authz = (req.headers["authorization"] as string) ?? "";
      const bearer = authz.startsWith("Bearer ") ? authz.slice(7) : "";
      const authed = (authToken ? bearer === authToken : false) || (bearer ? isValidAccessToken(bearer) : false);
      if (!authToken || !authed) {
        const base = `https://${req.headers.host}`;
        res.writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
        });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      if (req.method !== "POST") {
        // Stateless server: no GET stream / DELETE session.
        res.writeHead(405, { "content-type": "application/json", allow: "POST" });
        res.end(JSON.stringify({ error: "method not allowed (stateless: use POST /mcp)" }));
        return;
      }

      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }

      // Fresh, stateless MCP server + transport per request.
      const server = new McpServer({ name: "tondemon-ai", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS });
      registerTools(server, source);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    }
  });

  httpServer.listen(port, () => {
    console.error(
      `[tondemon-ai] HTTP MCP server on :${port}/mcp ` +
        `(auth: ${authToken ? "bearer token required" : "OPEN — set MCP_AUTH_TOKEN!"}). ` +
        `Source: ${JSON.stringify(desc)}`,
    );
  });
}
