# Tondemon AI — MCP server image (multi-stage, runs the HTTP transport).
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The playbook is the single prompt source (MCP instructions + Slack system
# prompt) — editable without a code change; can also be overridden at runtime
# with a bind mount + PLAYBOOK_FILE.
COPY playbook ./playbook

# HTTP (Streamable HTTP) transport on 8080; set MCP_AUTH_TOKEN + a source at runtime.
ENV MCP_HTTP_PORT=8080
EXPOSE 8080
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
