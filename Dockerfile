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

# Runtime: production defaults and no self-upgrade check. The sole dependency
# (MCP SDK) is pure JS with no postinstall build step, so --ignore-scripts above
# is safe.
#
# XLSX_FOR_AI_CI is deliberately NOT set. It marks an automated run, and a person
# who runs this image is not one: with it set, the image skipped sign-in and every
# request went out with no key and came back "Invalid or missing API key". Without
# it, the first tool call answers with a sign-in link and code like any other host.
# (To keep the sign-in between runs, mount a volume at /home/node/.xlsx-for-ai.)
ENV NODE_ENV=production \
    XFA_NO_AUTO_UPDATE=1 \
    XFA_CONFIG_DIR=/home/node/.xlsx-for-ai

# Drop root: node:slim ships a non-privileged `node` user.
USER node

# Launch the stdio MCP server. tools/list responds without SERVER_KEY.
ENTRYPOINT ["node", "mcp.js"]
