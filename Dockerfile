# syntax=docker/dockerfile:1.6

FROM node:20-alpine AS deps
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=development
ENV YARN_CACHE_FOLDER=/yarn-cache
COPY package.json yarn.lock ./
RUN corepack enable \
  && yarn config set registry https://registry.npmjs.org \
  && for attempt in 1 2 3 4 5; do \
    yarn install --frozen-lockfile --production=false --network-timeout 600000 && break; \
    if [ "$attempt" = "5" ]; then exit 1; fi; \
    sleep $((attempt * 15)); \
  done

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
ENV YARN_CACHE_FOLDER=/yarn-cache

COPY package.json yarn.lock ./
COPY --from=deps /yarn-cache /yarn-cache
RUN corepack enable \
  && yarn config set registry https://registry.npmjs.org \
  && for attempt in 1 2 3 4 5; do \
    yarn install --frozen-lockfile --production=true --prefer-offline --network-timeout 600000 && break; \
    if [ "$attempt" = "5" ]; then exit 1; fi; \
    sleep $((attempt * 15)); \
  done \
  && yarn cache clean

COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY scripts/prisma-deploy.sh ./scripts/prisma-deploy.sh
COPY scripts/ensure-prisma-compat-roles.js ./scripts/ensure-prisma-compat-roles.js

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
  CMD curl -sf http://localhost:3001/api/v1/health/ready || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
# Migrations are intentionally not part of the default boot path. Run
# `yarn prisma:deploy` as a controlled release step before starting/updating
# the API container. `start:prod:migrate` remains available as an explicit
# one-shot compatibility command when an operator chooses that behavior.
CMD ["node", "dist/src/main"]
