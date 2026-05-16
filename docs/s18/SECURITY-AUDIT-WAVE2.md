# S18 Wave 2 — Security Audit (org-credentials)

**Audit date:** 2026-05-15
**Auditor:** bravy-security-engineer (via agent-cto orchestration)
**Scope:** módulo `src/modules/org-credentials/` + `src/modules/ai-agents/providers/` + tabelas `organization_credentials`, `organization_capability_routing`, `organization_credential_audits`.

## Veredito: APROVADO COM REQUISITOS — deploy seguro mediante ENCRYPTION_KEY env setada em prod ANTES do app boot

---

## 1. Encryption-at-rest (AES-256-GCM)

| Check | Status | Evidência |
|---|---|---|
| Algoritmo correto | ✅ | `aes-256-gcm` (`crypto.service.ts:24`) — authenticated encryption with associated data, IV-misuse resistant |
| IV length | ✅ | 12 bytes (`IV_LENGTH = 12`) — GCM standard, NÃO usa 16B (que reduz security margin) |
| IV randomness | ✅ | `crypto.randomBytes(12)` por encrypt — cada call gera IV novo, mesmo plaintext encrypta diferente |
| AuthTag validation | ✅ | `decipher.setAuthTag(authTag)` + `decipher.final()` throws em tampering. CryptoService.decrypt re-throws InternalServerErrorException sem leak de erro detalhado |
| Master key strength | ✅ | 32 bytes (256 bits) hex, validado por regex `/^[0-9a-fA-F]{64}$/` no boot |
| Master key source | ✅ | `ENCRYPTION_KEY` env var. Em prod, throw no boot se ausente (fail-fast). Em dev, gera efêmera com WARN ruidoso |
| Plaintext em memória | ⚠️ ACEITÁVEL | Decrypt() retorna string que vive na heap. Best-effort clear comentado mas Node não permite zeroizar. Risco: dump de memória/swap pode revelar. Mitigado por: cache TTL curto (60s), não imprimir em logs, GC reclaim |
| Backward compat | ✅ | Encrypted blobs salvos uma vez ficam stable (key rotation muda master key → re-encrypt all rows necessário; runbook documentado) |

**Conclusão**: encryption forte, padrão indústria. Único caveat: garantir ENCRYPTION_KEY persistente entre restarts em prod.

---

## 2. IDOR (Insecure Direct Object Reference)

| Check | Status | Evidência |
|---|---|---|
| OrgGuard injeta orgId do JWT | ✅ | `@CurrentOrg('id')` resolve do payload JWT validado, NÃO de query/body |
| Service filtra por orgId obrigatório | ✅ | Todas queries Prisma usam `where: { organizationId }` ou unique compound `organizationId_provider`. Não há query sem filtro |
| upsert/update unique por (orgId, provider) | ✅ | Constraint `@@unique([organizationId, provider])` no Prisma + uso de `organizationId_provider` no `where` |
| Cascade delete em Organization.delete | ✅ | `onDelete: Cascade` em todas FK pra Organization — cleanup automático |
| listMasked nunca expõe encryptedKey | ✅ | `select` explícito omite `encryptedKey` (linha 35-46 do org-credentials.service.ts) |
| getDecryptedKey uso interno only | ✅ | Não há endpoint HTTP que chame este método. Comentário explícito "USO INTERNO APENAS" + caller único é ProviderResolverService injetado |
| Test endpoint requer roles OWNER/ADMIN | ✅ | `@Roles(OrgRole.OWNER, OrgRole.ADMIN)` em test endpoint |
| PUT/DELETE só OWNER | ✅ | `@Roles(OrgRole.OWNER)` — ADMIN não pode mudar credentials, só testar |

**Conclusão**: zero IDOR identificado. Modelo de autorização explícito e bem-isolado.

---

## 3. Audit logging

| Check | Status | Evidência |
|---|---|---|
| Append-only | ✅ | Service expõe apenas `log()`. Sem update/delete públicos |
| Cobertura de ações | ✅ | CREATED/UPDATED/DELETED/TESTED_SUCCESS/TESTED_FAILURE/ROUTING_CHANGED — 6 ações cobertas |
| ActorUserId capturado | ✅ | `@CurrentUser('id')` → service.log({ actorUserId }) |
| IP + UserAgent | ✅ | `@Ip()` decorator + `@Headers('user-agent')` capturam contexto da request |
| NÃO loga plaintext key | ✅ | `detail` field nunca contém apiKey — apenas metadata estrutural (ex: "ANTHROPIC->OPENAI") |
| Indexed for query | ✅ | `@@index([organizationId, createdAt])` permite filtro por org + ordenação temporal |
| Falha de log não bloqueia mutação | ⚠️ NOTÁVEL | Best-effort: try/catch + ERROR log. Pra LGPD/SOC strict, recomendaria failure = transaction rollback, mas trade-off aceitável pra projeto interno |

**Conclusão**: cobertura suficiente. Para enforcement strict (SOC2/ISO27001) trocar best-effort → strict (tech debt P2).

---

## 4. Key leakage prevention

| Check | Status | Evidência |
|---|---|---|
| keyHint só last 4 chars | ✅ | `CryptoService.hint(plaintext).slice(-4)` |
| Plaintext nunca em response JSON | ✅ | listMasked usa `select` whitelist sem `encryptedKey` |
| Plaintext nunca em logs (logger.log/warn/error) | ✅ | Grep no codebase: zero log com apiKey/encryptedKey direto. CryptoService.decrypt falha sem echo do contexto |
| Plaintext nunca em error message HTTP | ✅ | `sanitizeError()` em credential-tester redacta padrão `sk-*` antes de retornar |
| Test connection errors saneadas | ✅ | `shortError()` em adapters trunca + safeJSON parse |
| Sentry filter (se aplicável) | ⚠️ TODO | Codebase não tem Sentry integrado hoje. Se adicionar, configurar `beforeSend` pra dropar campos `apiKey`/`encryptedKey`/`ENCRYPTION_KEY` |
| Stacktrace não inclui plaintext | ✅ | Decrypt failure throws InternalServerErrorException genérica, sem cause |

**Conclusão**: defense-in-depth aplicada. Quando Sentry for adicionado, filtro deve ser estendido pra esses campos.

---

## 5. Rate limiting

| Check | Status | Evidência |
|---|---|---|
| Test endpoint protegido | ✅ | `CredentialTestThrottleGuard` (10/min/(org,ip)) |
| Algoritmo correto | ✅ | Sliding window in-memory, espelha AuthThrottleGuard (battle-tested no S16) |
| Multi-instance ready | ❌ ACEITÁVEL | In-memory: cada instância tem counter próprio. Tech debt P2 quando escalar pra >1 réplica. Hoje bullq2 prod roda single instance |
| Outros endpoints sem rate limit | ⚠️ ACEITÁVEL | PUT/DELETE não têm rate limit dedicado mas estão protegidos por: (a) JWT auth, (b) role OWNER (poucos usuários por org), (c) audit log. Risco baixo |

**Conclusão**: protección suficiente. Migrar pra Redis-backed quando bullq2 escalar.

---

## 6. Capability routing validation

| Check | Status | Evidência |
|---|---|---|
| EMBEDDINGS bloqueia ≠ OPENAI | ✅ | ConflictException no service.updateRouting |
| TRANSCRIPTION bloqueia ANTHROPIC | ✅ | ConflictException |
| Provider sem credential silencioso fallback ENV | ✅ | ProviderResolverService.source = 'ENV' transparente |
| Provider sem env tampouco → erro claro | ✅ | source='NONE' → InternalServerErrorException com mensagem actionable |

---

## 7. Riscos residuais & mitigações

### Risco R1 — ENCRYPTION_KEY rotação
**Impacto**: rotacionar master key invalida todos os encryptedKey existentes. App em prod precisa de window de re-encrypt antes/depois da rotação.

**Mitigação**: runbook `encryption-key-rotation.md` documenta procedimento. Recomendado: SOMENTE rotacionar em incident response (compromise suspeito). Não há policy de rotação periódica neste projeto interno.

### Risco R2 — Dump de memória/swap
**Impacto**: plaintext apiKey vive ~60s em heap (cache TTL). Memory dump pode revelar.

**Mitigação**: VPS sob controle exclusivo Sbroggio Adv (acesso SSH apenas Doc). Sem swap habilitado (não confirmado — verificar). Risco aceitável pra projeto interno.

### Risco R3 — Replay de credential antiga
**Impacto**: se atacante captura blob encrypted antes de PUT que rotaciona, e tem ENCRYPTION_KEY, pode usar.

**Mitigação**: IV é random por encrypt → mesmo plaintext encripta diferente. Mas atacante com master key + qualquer blob = read plaintext. **Mitigação real**: ENCRYPTION_KEY no 1Password do Doc, não em git, não em .env commitado.

### Risco R4 — Trojan via UI: usuário admin malicioso ROTAS pra provider externo dele
**Impacto**: ADMIN pode mudar routing, redirecionando tráfego LLM pra credencial dele. Conversation prompts vazam.

**Mitigação parcial**: routing mudança vai pra audit log → detectável. Mitigação completa: restringir routing a OWNER only. **Recomendação**: tightening pra P2 — mudar `@Roles(OWNER, ADMIN)` em routing PATCH pra apenas OWNER.

---

## 8. Pré-deploy checklist

- [ ] `ENCRYPTION_KEY` env setada em prod via Coolify API (`openssl rand -hex 32`)
- [ ] Tag `pre-s18-wave2` confirmada em api `e9ac29b` e web `73e9c91` (sanity rollback)
- [ ] Migration `20260515160000_org_ai_credentials` testada em staging primeiro? (não há staging dedicado bullq2 — testar local)
- [ ] Runbook `encryption-key-rotation.md` salvo em `.qa-artifacts/s18-wave2/`
- [ ] Backup pg_dump weekly ativo (já garantido por FASE 5 C5 do S17 — schedule UUID `o103oy229jhk3ddvucph18q6`)
- [ ] Smoke pós-deploy: criar credential Anthropic, testar conexão, mudar routing, validar fallback env

## 9. Tech debt monitorável (não-bloqueante)

| ID | Descrição | Prioridade |
|---|---|---|
| TD-W2-001 | Migrar rate limit pra Redis quando bullq2 escalar | P2 |
| TD-W2-002 | Audit log strict (rollback em failure) pra SOC2 | P2 |
| TD-W2-003 | Tighten routing PATCH pra OWNER only | P2 |
| TD-W2-004 | Sentry beforeSend filter (quando Sentry for adicionado) | P3 |
| TD-W2-005 | embed()/retrieve() callers internos passarem orgId | P2 |
| TD-W2-006 | Gemini transcription Files API path full impl | P2 (esperar Doc demand) |
| TD-W2-007 | Memory zeroization via secure-memory lib (sodium-native) | P3 |
