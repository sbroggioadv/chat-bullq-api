# S17/C2 — Remover FQDN `sslip.io` dos apps bullq2 no Coolify

> **Status:** preparado para aprovação Doc · 2026-05-13 · operação reversível (~5min para rollback)
> **Owner:** bravy-devops-engineer · **Aprovador:** Doc (requer `s` explícito)
> **Pré-requisito atendido:** V1 PROD já removido (S17/C1). Não há fallback DNS sslip.io ativo apontando pro V2.

---

## Contexto

Pós-migração S16 (`sslip.io → iacombativa.com`, 2026-05-09) os apps bullq2 ficaram com **duplo FQDN** no Coolify:

| App | UUID | FQDN canônico | FQDN sslip.io a remover |
|---|---|---|---|
| `bullq2-api` | `xffcn65kd8nlhuxxabf0p5dj` | `https://api.bullq.iacombativa.com` | `https://bullq2-api.187.127.30.142.sslip.io` |
| `bullq2-web` | `kibrg7bec45zoujfltcxlegd` | `https://bullq.iacombativa.com` | `https://bullq2-web.187.127.30.142.sslip.io` |

A entrada `sslip.io` foi mantida como fallback de rollback até **2026-05-17** (decisão S16). Como V1 PROD já foi deletado em S17/C1 (2026-05-13), a janela de rollback fechou e o sslip.io vira **superfície morta** — qualquer cliente legacy apontando pra lá deve ser corrigido, não acomodado.

---

## Verificação de clientes do sslip.io (executada 2026-05-13)

Auditoria de quem ainda pode estar batendo no sslip.io:

| Cliente potencial | Verificação | Resultado |
|---|---|---|
| Webhook Zappfy | URL configurada via painel zappfy.io aponta pra `api.bullq.iacombativa.com/api/v1/webhooks/WHATSAPP_ZAPPFY` (cutover S16 B3, 2026-05-09) | ✅ Não usa sslip.io |
| Web app prod | Bundle Next.js usa `NEXT_PUBLIC_API_URL=https://api.bullq.iacombativa.com/api/v1` (env Coolify) | ✅ Não usa sslip.io |
| Privacy policy publicada | `https://iacombativa.com/privacidade` aponta usuário pra `bullq.iacombativa.com` | ✅ Não usa sslip.io |
| Web fallback hardcoded | `chat-bullq-web/next.config.ts:10` apontava pra sslip.io | 🔴 **Corrigido nesta sprint** (branch `feat/s17-c2-web-sslip-fallback`) |
| API `.env.coolify.example` | `CORS_ORIGIN` e `GOOGLE_REDIRECT_URI` listavam sslip.io | 🔴 **Corrigido nesta sprint** (esta branch) |
| DNS externo (qualquer A/CNAME) | `*.sslip.io` é DNS pass-through (sslip.io serve qualquer IP encoded no hostname); ninguém configura DNS apontando pra ele | ✅ Não há DNS externo |
| GitHub Actions / CI custom | API e Web não têm workflows próprios (`.github/workflows/`) — só Coolify build/deploy | ✅ Sem CI custom |

**Conclusão:** seguro remover. Único risco residual: alguém com bookmark/teste local apontando pra sslip.io — mitigação = mensagem 503 do reverse proxy Coolify após remoção (claro de diagnosticar).

---

## Operação (curl prontos pra Doc executar)

> **Pré-requisito:** definir `COOLIFY_API_TOKEN` (1Password ou prompt local). Endpoint base: `http://187.127.30.142:8000/api/v1`.

### Step 1 — Snapshot atual dos FQDNs (read-only, sempre executar antes)

```bash
export COOLIFY_TOKEN="$(op read 'op://Claude-Code-Dev/Coolify API Token/credential')"
# Se não tiver no 1Password: pegar via Coolify UI → Settings → API Tokens.

# API app
curl -sS -H "Authorization: Bearer $COOLIFY_TOKEN" \
  "http://187.127.30.142:8000/api/v1/applications/xffcn65kd8nlhuxxabf0p5dj" \
  | jq '{name, fqdn, status}'

# Web app
curl -sS -H "Authorization: Bearer $COOLIFY_TOKEN" \
  "http://187.127.30.142:8000/api/v1/applications/kibrg7bec45zoujfltcxlegd" \
  | jq '{name, fqdn, status}'
```

**Esperado:** `fqdn` retorna string com 2 URLs separadas por vírgula (canônica + sslip.io).

### Step 2 — PATCH para remover sslip.io (executar SOMENTE com `s` Doc)

```bash
# API: manter só iacombativa.com
curl -sS -X PATCH \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H "Content-Type: application/json" \
  "http://187.127.30.142:8000/api/v1/applications/xffcn65kd8nlhuxxabf0p5dj" \
  -d '{"fqdn":"https://api.bullq.iacombativa.com"}' \
  | jq .

# Web: manter só iacombativa.com
curl -sS -X PATCH \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H "Content-Type: application/json" \
  "http://187.127.30.142:8000/api/v1/applications/kibrg7bec45zoujfltcxlegd" \
  -d '{"fqdn":"https://bullq.iacombativa.com"}' \
  | jq .
```

> **Nota:** PATCH no `fqdn` reescreve a lista inteira (não é incremental). É por isso que listamos somente o canônico — o sslip.io é implicitamente removido.

### Step 3 — Re-deploy (Coolify regenera Caddy/Traefik com FQDNs novos)

Coolify dispara re-deploy automático após PATCH de FQDN. Aguardar ~30-60s e validar:

```bash
# Re-deploy automático esperado. Se não, forçar:
curl -sS -X POST \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  "http://187.127.30.142:8000/api/v1/applications/xffcn65kd8nlhuxxabf0p5dj/deploy"

curl -sS -X POST \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  "http://187.127.30.142:8000/api/v1/applications/kibrg7bec45zoujfltcxlegd/deploy"
```

### Step 4 — Smoke test (cabe falhar nos sslip.io, deve passar nos iacombativa.com)

```bash
# Canônicos: 200 esperado
curl -sS -o /dev/null -w "API canon: %{http_code}\n" https://api.bullq.iacombativa.com/api/v1/health
curl -sS -o /dev/null -w "Web canon: %{http_code}\n" https://bullq.iacombativa.com/login

# Sslip.io: 404/503 esperado (FQDN não está mais registrado no proxy)
curl -sS -o /dev/null -w "API sslip: %{http_code}\n" https://bullq2-api.187.127.30.142.sslip.io/api/v1/health
curl -sS -o /dev/null -w "Web sslip: %{http_code}\n" https://bullq2-web.187.127.30.142.sslip.io/login
```

**Critério de sucesso:**
- Canônicos: `200`
- sslip.io: `404` (Coolify proxy não tem rota) ou `503` (handshake TLS falha — também ok)

### Step 5 — Smoke webhook Zappfy (caminho crítico)

```bash
# Health do canal ativo, validando que webhook ainda chega
curl -sS https://api.bullq.iacombativa.com/api/v1/health/ready | jq '.checks'
```

E peço pro Doc enviar 1 msg WhatsApp real pra Maria Alice (`+55 17 99788-7713`, ver `~/.claude/projects/-Users-luissbroggio-Dev-bullq2/memory/project_maria_alice_contact.md`) ou aguardar uma msg inbound natural pra confirmar pipeline saudável.

---

## Rollback (se algo quebrar pós-PATCH)

PATCH inverso adiciona sslip.io de volta:

```bash
# API: rollback
curl -sS -X PATCH \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H "Content-Type: application/json" \
  "http://187.127.30.142:8000/api/v1/applications/xffcn65kd8nlhuxxabf0p5dj" \
  -d '{"fqdn":"https://api.bullq.iacombativa.com,https://bullq2-api.187.127.30.142.sslip.io"}'

# Web: rollback
curl -sS -X PATCH \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H "Content-Type: application/json" \
  "http://187.127.30.142:8000/api/v1/applications/kibrg7bec45zoujfltcxlegd" \
  -d '{"fqdn":"https://bullq.iacombativa.com,https://bullq2-web.187.127.30.142.sslip.io"}'
```

ETA rollback: ~2 min (PATCH + redeploy + smoke).

---

## Pós-execução

- [ ] Atualizar `MEMORY.md` (linha "FASE 5 Cleanup V1 + infra hardening — C2 DONE")
- [ ] Atualizar `plan.md` S17 FASE 5 C2 → ✅
- [ ] Commit do que está nesta branch após smoke OK
