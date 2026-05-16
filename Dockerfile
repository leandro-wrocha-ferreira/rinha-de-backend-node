FROM node:20-alpine AS builder

WORKDIR /app

# Instalar pnpm
RUN npm i -g pnpm

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:20-alpine

WORKDIR /app

RUN npm i -g pnpm

COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/dist ./dist
COPY src/references ./src/references

EXPOSE 3000

CMD ["node", "dist/main"]
