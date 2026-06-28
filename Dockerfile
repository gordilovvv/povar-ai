FROM node:24-slim
WORKDIR /app

RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY . .
ENV NODE_ENV=production

RUN useradd --create-home nodeuser
USER nodeuser

CMD ["node", "src/index.ts"]
