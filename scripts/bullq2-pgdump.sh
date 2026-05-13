#!/usr/bin/env bash
set -euo pipefail
CONTAINER_UUID="pxham5zg74yq5itlnwfm3rdm"
DB_USER="bravy"
DB_NAME="chat_bullq"
BACKUP_DIR="/root/backups"
RETENTION_COUNT=8
PG_PASSWORD_FILE="/root/.bullq2-pgpass"

[[ -f "$PG_PASSWORD_FILE" ]] || { echo "FAIL: pgpass missing" >&2; exit 1; }
PG_PASSWORD="$(cat "$PG_PASSWORD_FILE")"

mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
OUTPUT="$BACKUP_DIR/bullq2-weekly-$TIMESTAMP.sql.gz"

echo "[$(date -Iseconds)] pg_dump -> $OUTPUT"
docker exec -e PGPASSWORD="$PG_PASSWORD" "$CONTAINER_UUID" \
  pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl | gzip -9 > "$OUTPUT"

[[ -s "$OUTPUT" ]] || { echo "FAIL: empty" >&2; exit 2; }
SIZE=$(stat -c '%s' "$OUTPUT")
[[ "$SIZE" -gt 1024 ]] || { echo "FAIL: too small ($SIZE)" >&2; exit 3; }
FIRST_LINES="$(zcat "$OUTPUT" 2>/dev/null | head -10)"
echo "$FIRST_LINES" | grep -q "PostgreSQL database dump" || { echo "FAIL: no SQL header" >&2; exit 4; }
TABLES="$(zcat "$OUTPUT" 2>/dev/null | grep -c "^CREATE TABLE")"
echo "OK: $OUTPUT ($SIZE bytes, $TABLES tables)"

cd "$BACKUP_DIR"
ls -t bullq2-weekly-*.sql.gz 2>/dev/null | tail -n +$((RETENTION_COUNT + 1)) | xargs -r rm -v
echo "Current backups:"
ls -lh bullq2-weekly-*.sql.gz | tail -$RETENTION_COUNT
