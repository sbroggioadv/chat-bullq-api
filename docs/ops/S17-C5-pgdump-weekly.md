# S17/C5 — pg_dump semanal agendado (DR mínimo bullq2 PROD)

> **Status:** preparado para aprovação Doc · 2026-05-13
> **Owner:** bravy-devops-engineer · **Aprovador:** Doc (requer `s` explícito)
> **Mitiga:** SPRINT-S16-RISK-MAP M8 — bullq2 DB sem backup agendado
> **Comando-base validado em PROD em S17/C1** (2026-05-13): `docker exec -e PGPASSWORD=... <uuid> pg_dump --no-owner --no-acl | gzip` (29 tabelas, 18308 lines, ~20MB comprimido)

---

## Decisão de design

Avaliadas 2 abordagens:

| Abordagem | Prós | Contras | Escolhida |
|---|---|---|---|
| **A. Cron systemd no host (root)** | Bare metal, sem dependência de Coolify, logs em journalctl | Acoplado ao host (se VPS migra, perde) | ✅ **SIM** |
| **B. Coolify Scheduled Task** | UI-driven, integra com painel | Coolify v4.0.0-beta.474 ainda tem schedule beta (Doc recusou upgrade pra stable hoje) | ❌ Esperar stable |

**Razão:** A é battle-tested (systemd cron desde 1995), evita depender de feature beta. Quando Coolify stable estabilizar Scheduled Tasks, migrar é trivial.

---

## Recursos prod (snapshot 2026-05-10)

| Recurso | UUID Coolify | Container name |
|---|---|---|
| Postgres bullq2 | `pxham5zg74yq5itlnwfm3rdm` | `pxham5zg74yq5itlnwfm3rdm` (Coolify nomeia DBs com UUID puro, sem prefixo — descoberta S17/C1) |
| Database | — | `chat_bullq` |
| User | — | `bravy` |
| Password | — | `op://Claude-Code-Dev/bullq2-pg/password` (1Password, NÃO commitar) |

---

## Artefatos preparados

### 1. Script de backup — `/root/scripts/bullq2-pgdump.sh`

> Não commitar este script no repo (contém path absoluto do host). Mantido nesta doc como referência. Doc cria via Coolify Terminal.

```bash
#!/usr/bin/env bash
# bullq2-pgdump.sh — backup semanal do bullq2 PROD postgres
# Rodado por systemd timer (ver bullq2-pgdump.service abaixo).
# Mantém últimos 8 dumps (8 semanas = 2 meses).

set -euo pipefail

# === Config ===
CONTAINER_UUID="pxham5zg74yq5itlnwfm3rdm"
DB_USER="bravy"
DB_NAME="chat_bullq"
BACKUP_DIR="/root/backups"
RETENTION_COUNT=8

# Senha vem de /root/.bullq2-pgpass (chmod 600), NÃO inline.
PG_PASSWORD_FILE="/root/.bullq2-pgpass"

if [[ ! -f "$PG_PASSWORD_FILE" ]]; then
  echo "FAIL: password file not found at $PG_PASSWORD_FILE" >&2
  exit 1
fi
PG_PASSWORD="$(cat "$PG_PASSWORD_FILE")"

mkdir -p "$BACKUP_DIR"

# === Backup ===
TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
OUTPUT="$BACKUP_DIR/bullq2-weekly-$TIMESTAMP.sql.gz"

echo "[$(date -Iseconds)] Starting pg_dump → $OUTPUT"

docker exec -e PGPASSWORD="$PG_PASSWORD" "$CONTAINER_UUID" \
  pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl \
  | gzip -9 > "$OUTPUT"

# === Validate (3 checks como em S17/C1) ===
if [[ ! -s "$OUTPUT" ]]; then
  echo "FAIL: output is empty" >&2
  exit 2
fi

SIZE_BYTES="$(stat -c %s "$OUTPUT")"
if [[ "$SIZE_BYTES" -lt 1024 ]]; then
  echo "FAIL: output suspiciously small ($SIZE_BYTES bytes)" >&2
  exit 3
fi

# Header check (gunzip primeiras linhas, deve ter "PostgreSQL database dump")
if ! gunzip -c "$OUTPUT" | head -3 | grep -q "PostgreSQL database dump"; then
  echo "FAIL: header check (no 'PostgreSQL database dump' in head)" >&2
  exit 4
fi

# Table count (deve ter pelo menos 10 tabelas — bullq2 atual tem 29+)
TABLE_COUNT="$(gunzip -c "$OUTPUT" | grep -c "^CREATE TABLE " || true)"
if [[ "$TABLE_COUNT" -lt 10 ]]; then
  echo "FAIL: table count too low ($TABLE_COUNT)" >&2
  exit 5
fi

echo "[$(date -Iseconds)] OK: $OUTPUT ($SIZE_BYTES bytes, $TABLE_COUNT tables)"

# === Rotation (manter últimos N) ===
cd "$BACKUP_DIR"
ls -1t bullq2-weekly-*.sql.gz 2>/dev/null \
  | tail -n +$((RETENTION_COUNT + 1)) \
  | xargs -r rm -v

echo "[$(date -Iseconds)] Done. Current backups:"
ls -lh "$BACKUP_DIR"/bullq2-weekly-*.sql.gz 2>/dev/null || true
```

### 2. systemd service — `/etc/systemd/system/bullq2-pgdump.service`

```ini
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

# Hardening
ProtectSystem=full
ProtectHome=false
NoNewPrivileges=true
```

### 3. systemd timer — `/etc/systemd/system/bullq2-pgdump.timer`

```ini
[Unit]
Description=bullq2 PROD postgres weekly pg_dump (Sun 03:00 BRT)
Requires=bullq2-pgdump.service

[Timer]
# BRT = UTC-3, então 03:00 BRT = 06:00 UTC.
# Domingo 03:00 BRT (carga baixa no Zappfy inbound).
OnCalendar=Sun *-*-* 06:00:00 UTC
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
```

---

## Instalação (Doc executa via Coolify Terminal como root, com `s` explícito)

> ⚠️ ACAO SENSIVEL: cria arquivos em `/root/`, instala systemd unit, agenda timer
> 📁 PATH: `/root/scripts/`, `/etc/systemd/system/`, `/root/.bullq2-pgpass`
> 💥 IMPACTO: bullq2-pgdump.timer roda toda Domingo 06:00 UTC; cria backups em `/root/backups/`
> Confirma? (s/n)

### Passo 1 — Salvar senha postgres (1x, chmod 600)

```bash
# Doc copia a senha real do 1Password e roda:
echo "<password-real-aqui>" > /root/.bullq2-pgpass
chmod 600 /root/.bullq2-pgpass
ls -la /root/.bullq2-pgpass
# Esperado: -rw------- 1 root root ... /root/.bullq2-pgpass
```

### Passo 2 — Criar script

```bash
mkdir -p /root/scripts /root/backups
# Doc cola o conteúdo do bloco "1. Script de backup" acima em /root/scripts/bullq2-pgdump.sh
# (recomendado: vim ou nano)
chmod +x /root/scripts/bullq2-pgdump.sh
```

### Passo 3 — Smoke test do script (executar 1x manualmente)

```bash
/root/scripts/bullq2-pgdump.sh
# Esperado: "OK: /root/backups/bullq2-weekly-YYYYMMDD-HHMMSS.sql.gz (..., 29 tables)"
ls -lh /root/backups/bullq2-weekly-*.sql.gz
# Esperado: ~20MB comprimido
```

### Passo 4 — Instalar systemd unit + timer

```bash
# Doc cola os 2 .service e .timer nos paths certos:
# /etc/systemd/system/bullq2-pgdump.service
# /etc/systemd/system/bullq2-pgdump.timer

systemctl daemon-reload
systemctl enable --now bullq2-pgdump.timer
systemctl status bullq2-pgdump.timer
# Esperado: "active (waiting)", "Trigger: Sun YYYY-MM-DD 06:00:00 UTC"
```

### Passo 5 — Verificar agendamento

```bash
systemctl list-timers --all bullq2-pgdump.timer
# Esperado: linha mostrando próximo trigger no domingo
```

### Passo 6 — Forçar execução manual (sanity)

```bash
systemctl start bullq2-pgdump.service
journalctl -u bullq2-pgdump -n 30 --no-pager
# Esperado: "OK: ... 29 tables", "Done. Current backups: ..."
```

---

## Rollback (desinstalar)

```bash
systemctl disable --now bullq2-pgdump.timer
rm -f /etc/systemd/system/bullq2-pgdump.{service,timer}
systemctl daemon-reload
# Manter scripts + senha + backups (não destruir DR)
```

---

## Pós-instalação

- [ ] Atualizar `MEMORY.md` (C5 DONE, próximo trigger = domingo)
- [ ] Atualizar `plan.md` S17 FASE 5 C5 → ✅
- [ ] Calendário Doc: lembrete em 2026-06-13 (1 mês) → validar que 4 dumps existem em `/root/backups/`
- [ ] Backlog **C1.5** (restore-test mensal) destravado — fazer em S18
- [ ] Backlog **C1.6** (off-site backup pra S3/cloud) — VPS-only é fragility; migrar dumps pra MinIO + sync pra Cloudflare R2 quando possível
