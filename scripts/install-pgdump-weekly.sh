#!/usr/bin/env bash
# install-pgdump-weekly.sh — S17/C5 installer
# Pré-req: /root/.bullq2-pgpass já existe (chmod 600)
# Executa: cria script, systemd service+timer, habilita timer, roda smoke

set -euo pipefail

if [[ ! -f /root/.bullq2-pgpass ]]; then
  echo "FAIL: /root/.bullq2-pgpass não existe. Cria primeiro:" >&2
  echo '  echo "<senha>" > /root/.bullq2-pgpass && chmod 600 /root/.bullq2-pgpass' >&2
  exit 1
fi

mkdir -p /root/scripts /root/backups

cat > /root/scripts/bullq2-pgdump.sh <<'SCRIPT_EOF'
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
SCRIPT_EOF
chmod +x /root/scripts/bullq2-pgdump.sh

cat > /etc/systemd/system/bullq2-pgdump.service <<'SVC_EOF'
[Unit]
Description=bullq2 PROD postgres weekly pg_dump
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/root/scripts/bullq2-pgdump.sh
StandardOutput=journal
StandardError=journal
SyslogIdentifier=bullq2-pgdump
ProtectSystem=full
ProtectHome=false
NoNewPrivileges=true
SVC_EOF

cat > /etc/systemd/system/bullq2-pgdump.timer <<'TIMER_EOF'
[Unit]
Description=bullq2 PROD postgres weekly pg_dump (Sun 03:00 BRT)
Requires=bullq2-pgdump.service

[Timer]
OnCalendar=Sun *-*-* 06:00:00 UTC
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
TIMER_EOF

systemctl daemon-reload
systemctl enable --now bullq2-pgdump.timer

echo ""
echo "=== Timer status ==="
systemctl status bullq2-pgdump.timer --no-pager | head -8
echo ""
echo "=== Proximo trigger ==="
systemctl list-timers --all bullq2-pgdump.timer --no-pager
echo ""
echo "=== Smoke test agora (criando primeiro backup) ==="
/root/scripts/bullq2-pgdump.sh
echo ""
echo "=== /root/backups/ depois do smoke ==="
ls -lh /root/backups/
