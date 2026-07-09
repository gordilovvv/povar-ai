FROM node:24-slim
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY . .
ENV NODE_ENV=production

USER node

CMD ["node", "src/webhook.ts"]
