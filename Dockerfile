# syntax=docker/dockerfile:1.6

FROM node:20-alpine AS deps
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=development
COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile --production=false

FROM node:20-alpine AS builder
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN yarn build

FROM node:20-alpine AS runner
# ffmpeg é necessário pro saveAudio transcodar webm/mp4 → ogg/opus (WhatsApp
# voice note exige container OGG). Sem isso, /messages/uploads/audio sempre
# devolve BadRequestException "Failed to process audio". O package ffmpeg
# do Alpine vem com libopus habilitado por padrão.
RUN apk add --no-cache openssl curl tini ffmpeg
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile --production=true && yarn cache clean

COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

RUN mkdir -p /app/uploads

# Declarar /app/uploads como volume — sinaliza pro Coolify/Docker que esse path
# precisa ser montado num volume persistente, senão TODA imagem/áudio enviado
# pelos operadores é apagado a cada redeploy. Bug descoberto 2026-05-16 quando
# Doc enviou screenshot via paste e o blob sumiu no redeploy seguinte.
# IMPORTANTE: declarar VOLUME no Dockerfile NÃO cria o volume automaticamente
# no Coolify — é só uma anotação. O bind mount real precisa ser configurado no
# painel: Storage tab → New Volume → Source: bullq2-api-uploads, Destination:
# /app/uploads. Sem essa config no Coolify, VOLUME vira anon volume (perdido).
VOLUME ["/app/uploads"]

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -sf http://localhost:3001/api/v1/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "DIRECT_URL=\"${DIRECT_URL:-$DATABASE_URL}\" npx prisma migrate deploy && node dist/src/main"]
