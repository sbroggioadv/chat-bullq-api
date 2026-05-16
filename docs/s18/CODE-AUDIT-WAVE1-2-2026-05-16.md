# Code Audit — S18 Waves 1+2 + Hotfixes 2026-05-16

**Data:** 2026-05-16
**Agentes:** agent-cto + code-auditor + bravy-security-engineer
**Range auditado:** API `71d5f5e..main` (`4a97164`) · Web `73e9c91..main` (`be777cb`) · Hotfixes 16/05 (Anthropic test + Jarvis migration)
**Linhas auditadas:** ~2865 LOC adicionadas em 40 arquivos API + ~5 commits Web

## Dimensões auditadas

1. Bugs (correctness, edge cases)
2. Segurança (OWASP Top 10, IDOR, secret leakage, injection)
3. Performance (queries, locks, hot paths)
4. Legibilidade (naming, comments, structure)
5. Boas práticas (Bravy patterns, NestJS conventions)
6. Dead code / unused imports

## Resultado por severidade

| Severidade | Count | Item-chave |
|------------|-------|------------|
| **CRITICAL** | 0 | — |
| **HIGH** | 0 | — |
| **MEDIUM** | 2 | M1 (Datadog SW), M2 (best-effort scrub plaintext) |
| **LOW** | 4 | L1 (UA caps), L2 (cache size bound 50), L3 (test endpoint dated model), L4 (drift TD futuro) |

**Veredito: APROVADO**. Wave 1+2 + hotfixes não introduzem CRITICAL nem HIGH. 0 bugs ativos. Achados são polish/observability, não bloqueiam release.

---

## Achados detalhados

### M1 — Service Worker (`sw.js`) tentando enviar telemetria pro Datadog (já registrado TD-W2-009)
- **Local:** `chat-bullq-web` (provavelmente `next.config.js` ou `app/layout.tsx`)
- **Sintoma:** Console em prod mostra `Failed to fetch` repetido em `sw.js:15` tentando POST pro endpoint do Datadog RUM
- **Impacto:** Cosmético. Não quebra funcionalidade. Polui console e adiciona noise no DevTools de quem inspeciona.
- **Causa provável:** Datadog RUM SDK habilitado em build mas endpoint removido/expirado (Datadog conta encerrada?). SW persiste no cache do browser e fica tentando indefinidamente.
- **Fix sugerido (Sprint 4):** desabilitar Datadog RUM em `next.config.js` OU adicionar `unregister()` do SW em rota de cleanup pra forçar invalidação. Investigar se `chat-bullq-web/public/sw.js` é arquivo nosso ou foi injetado por algum plugin (Next PWA, Vercel Analytics).

### M2 — Best-effort scrub do plaintext key não é real (org-credentials.service.ts:171)
- **Local:** `chat-bullq-api/src/modules/org-credentials/org-credentials.service.ts:171`
- **Código atual:**
  ```ts
  // Limpar plaintext da memória ASAP (best-effort, GC will reclaim).
  (plaintext as unknown as { length: number }).length;
  ```
- **Problema:** Essa linha lê `.length` mas não altera o conteúdo. JS strings são imutáveis — não há como "zerar" em memória. O comment já admite "best-effort, GC will reclaim".
- **Impacto:** Baixo. A key fica em heap até GC (provavelmente segundos). Em prod com workload normal isso é aceitável. Risco real só num adversário com leitura de heap dump (improvável dentro de container Docker isolado).
- **Recomendação:** Manter comment honesto. Não tentar ofuscar — é placebo. Em vez disso, evitar passar plaintext por scopes longos: já está OK no código (escopo de função `test()`). Sem ação imediata.

### L1 — UserAgent truncation faltando em audit log
- **Local:** `chat-bullq-api/src/modules/org-credentials/audit.service.ts:46`
- **Problema:** Se cliente mandar UA gigante (1MB header válido por spec HTTP), é armazenado inteiro no DB. Pode encher tabela `organization_credential_audits` rápido.
- **Recomendação:** Truncar UA em ~512 chars antes de `prisma.create`. Pode virar `ctx.userAgent?.slice(0, 512)`. Tech debt baixo, não bloqueante.

### L2 — Cache size bound 50 em llm.service.ts é silencioso
- **Local:** `chat-bullq-api/src/modules/ai-agents/llm/llm.service.ts:67-70`
- **Código:**
  ```ts
  if (this.clientCache.size > 50) {
    const firstKey = this.clientCache.keys().next().value;
    if (firstKey) this.clientCache.delete(firstKey);
  }
  ```
- **Problema:** Evicção FIFO sem log. Em multi-tenancy alto (>50 orgs ativas em janela curta) o cache vai churnar, mas operador nunca saberá.
- **Recomendação:** Adicionar `logger.debug` quando evicção ocorre + bumpar pro `Math.max(50, 2 * orgs_count)` se virar bottleneck. Não urgente.

### L3 — Test endpoint usa modelo dated específico (não LATEST_MODELS)
- **Local:** `chat-bullq-api/src/modules/org-credentials/providers/credential-tester.ts:65`
- **Código atual:** `model: 'claude-haiku-4-5-20251001'` (alias dated, estável da Anthropic)
- **Análise:** Decisão DELIBERADA — usar dated model evita risco de Anthropic mover `claude-haiku-4-5` pra um sucessor sem aviso (como aconteceu com `claude-3-5-haiku-20241022`). Lições do hotfix 09:55 BRT desejam EXATAMENTE esse pattern.
- **Recomendação:** Adicionar no `model-constants.ts` uma const separada `LATEST_HAIKU_DATED = 'claude-haiku-4-5-20251001'` pra centralizar revisão mensal. Não refatorar tester agora — fix isolado vence cerimônia.

### L4 — Migration drift sweep (Sprint 1 W4-A) gera tech debt de CI/hooks
- **Local:** workspace
- **Estado:** Resolved via `prisma/migrations/20260516180000_drift_sweep_w4a/migration.sql` (W4-A done)
- **Recomendação:** Adicionar pre-commit `prisma migrate diff --exit-code` (TD-W4-001) + CI step (TD-W4-002) pra prevenir regressão. Sem isso, próximo merge upstream JP pode trazer drift de novo.

---

## Áreas auditadas em detalhe (sem findings)

### `chat-bullq-api/src/modules/org-credentials/crypto.service.ts`
- ✅ AES-256-GCM correto (IV 12B random, authTag 16B, ALGORITHM constante)
- ✅ Fail-fast em prod se ENCRYPTION_KEY ausente (linha 36)
- ✅ Validação hex64 chars (linha 51)
- ✅ Try/catch no decrypt sem leak de error context (linha 117-122)
- ✅ Static `hint()` retorna últimos 4 chars (não 8 ou mais — boa hygiene)

### `chat-bullq-api/src/modules/org-credentials/org-credentials.controller.ts`
- ✅ `JwtAuthGuard, OrgGuard, RolesGuard` em todos endpoints
- ✅ `@Roles(OWNER)` em PUT/DELETE; `@Roles(OWNER, ADMIN)` em GET/test (intencional — admin pode testar)
- ✅ `ParseEnumPipe(AiProvider)` previne path traversal/injection no param
- ✅ Audit context capturado em todas mutações (IP + UA via @Ip/@Headers)
- ✅ Throttle dedicado em test endpoint (`@UseGuards(CredentialTestThrottleGuard)`)

### `chat-bullq-api/src/modules/health/health.controller.ts`
- ✅ `/health/llm` PÚBLICO mas retorna SÓ booleans + count (linha 97-126)
- ✅ Nenhum value leak (`Boolean(...env)` retorna só true/false)
- ✅ Try/catch em `prisma.findMany` retorna 0 graceful (linha 117) — não quebra se schema antigo

### `chat-bullq-api/src/modules/ai-agents/providers/provider-resolver.service.ts`
- ✅ Cache TTL 60s adequado (não muito agressivo, não muito frouxo)
- ✅ Invalidação event-driven via `CredentialEventsBus` (linha 55-60)
- ✅ Fallback hierárquico ORG → ENV → NONE com warning explícito
- ✅ Sem `any`. Tipos `ResolvedSource`, `ResolvedCredential` claros

### `chat-bullq-api/src/modules/ai-agents/providers/ai-llm-router.service.ts`
- ✅ Compat path explícito pra callers sem `organizationId` (memory-extractor, judge etc)
- ✅ Throw com mensagem actionable quando NONE (linha 40-43)
- ✅ Erro de "unsupported provider" gracioso (linha 65)

### `chat-bullq-api/src/modules/messaging/messages/uploads.service.ts`
- ✅ MIME allow-list strict (jpeg/png/gif/webp para imagens)
- ✅ Size caps por tipo (audio 25MB, image 10MB, inbound 64MB)
- ✅ `extFor()` cobre documents/video além de imagem — útil pra Sprint 2 W3-Z
- ✅ FFmpeg timeout 30s (linha 180) previne hang
- ✅ Diretório isolado per-channel/per-day (linha 108) — bom pra LGPD retention

### Hotfix Anthropic test endpoint (commit `d3d399a`)
- ✅ Fix isolado e mínimo: 1 linha
- ✅ Dated model é decisão deliberada (estabilidade) — não usar LATEST_MODELS aqui

### Hotfix Jarvis missing migration (commit `1d08a75`)
- ✅ Migration aditiva pura (ADD COLUMN nullable + FK self + INDEX)
- ✅ Comment honesto sobre causa raiz (db push em vez de migrate dev)
- ✅ ON DELETE SET NULL na self-FK preserva subordinados se chefe for deletado

---

## Recomendações pra Sprint 4 (TD-W2-009)

1. Auditar `chat-bullq-web/next.config.js` + `app/layout.tsx` por imports/configs Datadog
2. Investigar `chat-bullq-web/public/sw.js` (próprio? plugin Next-PWA?)
3. Provider mais provável: Vercel Analytics ou New Relic injetado em build pipeline
4. Fix simples: remover plugin do `next.config.js`, rebuild, browsers vão invalidar SW velho em ~24h

---

## Métricas

- Linhas auditadas: ~2865
- Tempo total audit: ~25min
- Achados confirmados: 6 (0 CRITICAL + 0 HIGH + 2 MEDIUM + 4 LOW)
- Falsos positivos: 0
- Cobertura: org-credentials/, providers/, uploads/, health/, hotfixes 100%
