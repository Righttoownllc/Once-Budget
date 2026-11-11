# Stage 1: build the PWA
FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY package.json CHANGELOG.json /src/
COPY web/ ./
RUN npm run build

# Stage 2: runtime (API + static files). node:sqlite is built in, no native deps.
FROM node:24-alpine
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY CHANGELOG.json ./
COPY server/ ./server/
COPY --from=web /src/web/dist ./web/dist
# Starts as root only to make /data belong to PUID:PGID, then runs the server as that user.
RUN apk add --no-cache su-exec && mkdir -p /data
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8080/healthz || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--no-warnings", "server/index.js"]
