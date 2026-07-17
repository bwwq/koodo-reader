FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

FROM mcr.microsoft.com/playwright:v1.61.1-noble
ENV NODE_ENV=production WEBVIEW_PORT=9223 WEBVIEW_DATA=/data
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY test ./test
RUN mkdir -p /data && chown -R pwuser:pwuser /app /data
USER pwuser
EXPOSE 9223
ENTRYPOINT ["node", "src/server.js"]
