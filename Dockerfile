# Server für Test-/Livebetrieb: Node-App + KoSIT-Validator (Java) in einem Container.
# Dateien/Archiv liegen unter /data → dort ein dauerhaftes Laufwerk einhängen. Start mit „init: true“ (Compose).

# 1) KoSIT-Validator + XRechnung-Konfiguration laden (JDK: curl + jar zum Entpacken)
FROM eclipse-temurin:21-jdk AS kosit
COPY scripts/kosit.sh /kosit.sh
RUN KOSIT_DIR=/opt/kosit /kosit.sh --download-only

# 2) Node-Laufzeit
FROM node:22-bookworm-slim AS node

# 3) App: Java (KoSIT) + Node
FROM eclipse-temurin:21-jre
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force
COPY --from=kosit /opt/kosit /opt/kosit
COPY . .
ENV HOST=0.0.0.0 PORT=3000 \
    ARCHIVE_DIR=/data/archive FILES_DIR=/data/files \
    KOSIT_DIR=/opt/kosit KOSIT_VALIDATOR_URL=http://127.0.0.1:8081
RUN useradd -r -u 10001 app && mkdir -p /data && chown app /data
USER app
EXPOSE 3000
CMD ["./scripts/container-start.sh"]
