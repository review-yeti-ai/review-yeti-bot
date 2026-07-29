FROM node:24-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV UV_THREADPOOL_SIZE=16
ENV NODE_OPTIONS="--enable-source-maps --max-old-space-size=512"

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

COPY dist ./dist
COPY public ./public

RUN install -d -o node -g node /app/data
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
