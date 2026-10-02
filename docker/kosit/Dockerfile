# KoSIT-Validator mit XRechnung-Konfiguration als HTTP-Dienst (POST / mit XML → Prüfbericht).
FROM eclipse-temurin:21-jre
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/kosit
COPY scripts/kosit.sh /opt/kosit/kosit.sh
ENV KOSIT_DIR=/opt/kosit/data KOSIT_HOST=0.0.0.0 KOSIT_PORT=8081
RUN /opt/kosit/kosit.sh --download-only
EXPOSE 8081
HEALTHCHECK CMD curl -fs http://127.0.0.1:8081/server/health || exit 1
CMD ["/opt/kosit/kosit.sh"]
