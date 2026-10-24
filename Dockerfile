FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    CAREER_DATA_DIR=/data \
    CAREER_HOST=0.0.0.0 \
    PORT=4189

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /data

EXPOSE 4189
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4189/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server/index.mjs"]
