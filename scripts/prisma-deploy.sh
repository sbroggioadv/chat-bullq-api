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

node scripts/ensure-prisma-compat-roles.js
exec npx prisma migrate deploy
