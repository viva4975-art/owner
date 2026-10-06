# Server für Test-/Livebetrieb: Node-App + KoSIT-Validator (Java) in einem Container.
# Dateien/Archiv liegen unter /data → dort ein dauerhaftes Laufwerk einhängen.
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-17-jre-headless curl unzip ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force
COPY scripts ./scripts
RUN KOSIT_DIR=/opt/kosit ./scripts/kosit.sh --download-only
COPY . .
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 \
    ARCHIVE_DIR=/data/archive FILES_DIR=/data/files \
    KOSIT_DIR=/opt/kosit KOSIT_VALIDATOR_URL=http://127.0.0.1:8081
RUN useradd -r -u 10001 app && mkdir -p /data && chown app /data /opt/kosit
USER app
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./scripts/container-start.sh"]
