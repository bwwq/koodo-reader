FROM --platform=$BUILDPLATFORM gradle:7.6.4-jdk8 AS builder
WORKDIR /src
COPY vendor/reader-legado /src/vendor/reader-legado
COPY legado-engine /src/legado-engine
WORKDIR /src/legado-engine
RUN gradle --no-daemon shadowJar

FROM eclipse-temurin:8-jre-alpine
RUN addgroup -S legado && adduser -S -G legado legado \
    && mkdir -p /data/jobs && chown -R legado:legado /data
COPY --from=builder /src/legado-engine/build/libs/koodo-legado-engine.jar /app/engine.jar
USER legado
VOLUME ["/data"]
EXPOSE 9080
ENV LEGADO_PORT=9080 LEGADO_DATA=/data JAVA_TOOL_OPTIONS="-Xms64m -Xmx512m -XX:+UseG1GC"
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:9080/health || exit 1
ENTRYPOINT ["java", "-jar", "/app/engine.jar"]
