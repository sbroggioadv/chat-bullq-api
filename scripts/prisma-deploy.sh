#!/bin/sh
set -eu

INPUT_DATABASE_URL="${DATABASE_URL:-}"
INPUT_DIRECT_URL="${DIRECT_URL:-}"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

if [ -n "$INPUT_DATABASE_URL" ]; then
  export DATABASE_URL="$INPUT_DATABASE_URL"
fi

if [ -n "$INPUT_DIRECT_URL" ]; then
  export DIRECT_URL="$INPUT_DIRECT_URL"
fi

if [ -z "${DIRECT_URL:-}" ] && [ -n "${DATABASE_URL:-}" ]; then
  export DIRECT_URL="$DATABASE_URL"
fi

if [ -z "${ZAI_API_KEY:-}" ] && [ -z "${ZHIPU_API_KEY:-}" ]; then
  echo "WARN: ZAI_API_KEY/ZHIPU_API_KEY is not set. LLM_AGENT now defaults to ZAI; make sure org-level ZAI credentials exist before routing production AI traffic." >&2
fi

node scripts/ensure-prisma-compat-roles.js
exec npx prisma migrate deploy
