# MCP server image for Glama introspection (tools/list) and self-hosting.
# xlsx-for-ai is a thin stdio client: tools/list is served from bundled
# schemas with no key and no network, so this image introspects fully offline.
FROM node:22-slim

WORKDIR /app

# Install the single production dependency against the lockfile. --ignore-scripts
# skips the postinstall MCP-registration hook (it is global/CI-gated and a no-op
# here, but skipping keeps the build hermetic).
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --chown=node:node . .

# Hermetic runtime: production defaults, no self-upgrade check, no
# Claude-config registration. The sole dependency (MCP SDK) is pure JS with no
# postinstall build step, so --ignore-scripts above is safe.
ENV NODE_ENV=production \
    XFA_NO_AUTO_UPDATE=1 \
    XLSX_FOR_AI_CI=1

# Drop root: node:slim ships a non-privileged `node` user.
USER node

# Launch the stdio MCP server. tools/list responds without SERVER_KEY.
ENTRYPOINT ["node", "mcp.js"]
