# Container image for running Agent Hub as a hub (e.g. a TrueNAS or other NAS app) that other
# machines report to. A container can't see the host's Claude Code sessions, so on its own it
# shows nothing: configure it with AGENT_HUB_HUB=1 and AGENT_HUB_MACHINES (or a keys file).
# Published as ghcr.io/uurdemir/agent-hub-ui by .github/workflows/docker.yml.
FROM node:22-alpine

# The process scanner needs a full `ps` (BusyBox's has no -axo).
RUN apk add --no-cache procps

WORKDIR /app
COPY package.json ./
COPY bin/ bin/
COPY server/ server/
COPY public/ public/

# Reachable through the container's published ports. The dashboard refuses this without
# AGENT_HUB_VIEWER_PASSWORD, so it is never open without a login. Hub-only: don't mount ~/.claude.
ENV HOST=0.0.0.0 \
    PORT=4317 \
    AGENT_HUB_INGEST_PORT=4318 \
    NODE_ENV=production
EXPOSE 4317 4318

USER node
ENTRYPOINT ["node", "bin/agent-hub.js", "--no-open"]
