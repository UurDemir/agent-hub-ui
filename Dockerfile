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
    AGENT_HUB_DATA_DIR=/data \
    NODE_ENV=production
EXPOSE 4317 4318

# The hub's state (machines, sessions, History) survives restarts here; mount a volume on it.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
# /healthz answers before the viewer login and carries no session data.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4317)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "bin/agent-hub.js", "--no-open"]
