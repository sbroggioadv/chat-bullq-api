# provision-tenant — provisionamento de tenant isolado + clone de squad

Script reutilizável e parametrizável que cria uma **organização nova e
isolada**, convida o **admin** (que define a própria senha) e, opcionalmente,
**clona um squad de agentes** de uma org-fonte preservando a hierarquia
orquestrador→workers.

- Script CLI: `scripts/provision-tenant.ts`
- Lógica reusável (DI-ready para o Aquecia): `src/modules/provisioning/`
  - `agent-clone.planner.ts` — puro, testável (filtro, cópia de campos, remap de `parentAgentId`)
  - `tenant-provisioning.service.ts` — orquestra org + convite + clone
  - `provisioning.module.ts` — wiring para um futuro endpoint self-service/admin

## O que faz

1. **Organização isolada** — cria `Organization` + department `Geral` default.
   A fronteira de multi-tenancy (todo dado escopado por `organizationId`)
   garante que a org nova não vê dados de nenhuma outra.
2. **Convite do admin** — reusa `OrganizationsService.inviteMember`
   (`organizations.service.ts:109`). Cria uma `Invitation`; o admin define a
   **própria senha** pelo link de aceite. O script **nunca** seta senha.
3. **Clone do squad** — lê os `AiAgent` da org-fonte (filtrando por
   kind/department/squad), recria na org nova copiando todos os campos de
   comportamento (kind, systemPrompt, squad, department, operationalContext,
   config S22 de scope/cadence, cadência de follow-up, humanização) e
   **remapeia `parentAgentId`** pros novos IDs, mantendo a árvore.
4. **WhatsApp** — **não** conecta canal real. Loga a instrução de criar o
   canal Zappfy pela UI (a criação de canal já auto-registra o webhook).

**Idempotente:** re-rodar com os mesmos `(nome, e-mail)` reusa a org (marcador
em `settings.provisioning`) e não duplica agentes (dedupe por nome).

## Como rodar

> Sempre rode com `--dry-run` primeiro. **Nunca** rode contra produção sem
> `CONFIRMO` explícito do Doc.

Dados reais (nome/e-mail/WhatsApp) entram **só via args na execução** — nunca
versionados. Os exemplos usam placeholders fictícios.

```bash
DATABASE_URL="postgres://user:pass@host:5432/db" \
  yarn ts-node -P tsconfig.json --transpile-only \
  scripts/provision-tenant.ts \
  --name "Acme Advocacia" \
  --email admin@example.com \
  --admin-name "Admin" \
  --role OWNER \
  --whatsapp 5511999999999 \
  --source-org <SOURCE_ORG_ID> \
  --kinds ORCHESTRATOR \
  --departments JURIDICO \
  --dry-run
```

Tire o `--dry-run` para executar de verdade.

## Argumentos (env como fallback; o arg tem precedência)

| Arg | Env | Descrição |
|-----|-----|-----------|
| `--name` | `TENANT_NAME` | Nome da nova org (**obrigatório**) |
| `--email` | `ADMIN_EMAIL` | E-mail do admin (**obrigatório**) |
| `--admin-name` | `ADMIN_NAME` | Nome sugerido do admin (só log) |
| `--role` | `ADMIN_ROLE` | `OWNER` \| `ADMIN` (default `OWNER`) |
| `--whatsapp` | `WHATSAPP_NUMBER` | E.164 sem `+` (só instrução, não conecta) |
| `--source-org` | `SOURCE_ORG_ID` | Org de onde clonar os agentes |
| `--inviter` | `INVITER_USER_ID` | User que envia o convite (default: OWNER da source-org) |
| `--kinds` | `AGENT_KINDS` | Filtro CSV: `ORCHESTRATOR,WORKER` |
| `--departments` | `AGENT_DEPARTMENTS` | Filtro CSV: `JURIDICO,VENDAS` |
| `--squads` | `AGENT_SQUADS` | Filtro CSV: `"Squad Jurídico"` |
| `--keep-pipeline-scope` | — | NÃO zera `pipelineScope` (default: zera) |
| `--dry-run` | — | Loga o plano sem escrever nada |
| `--help` | — | Ajuda |

### Semântica do filtro (união)

Cada `--kinds`/`--departments`/`--squads` vira um **seletor**; o agente entra
se casar com **qualquer** um. Ex.: `--kinds ORCHESTRATOR --departments JURIDICO`
clona **todos os orquestradores** + **todos do jurídico** — a hierarquia fica
íntegra porque os pais orquestradores entram junto. Sem filtro = clona todos os
agentes vivos da org-fonte.

`pipelineScope` (S22) guarda IDs de pipeline da org-fonte, que **não** cruzam
para a org nova. Por padrão o script **zera** esse campo (agente vira fallback
genérico até o admin reconfigurar). Use `--keep-pipeline-scope` só se souber o
que está fazendo.

## Preset "advogada isolada" (caso concreto) — NÃO executar sem `CONFIRMO` do Doc

Dar acesso isolado a um usuário com org própria (ex.: uma advogada do
escritório). **Sem PII versionada:** os valores reais (nome/e-mail/WhatsApp)
entram só via args na execução — os exemplos usam placeholders fictícios.

```bash
DATABASE_URL="<DB_ALVO>" yarn ts-node -P tsconfig.json --transpile-only \
  scripts/provision-tenant.ts \
  --name "Acme Advocacia" \
  --email admin@example.com \
  --admin-name "Admin" \
  --role OWNER \
  --whatsapp 5511999999999 \
  --source-org <ORG_FONTE> \
  --kinds ORCHESTRATOR \
  --departments JURIDICO \
  --dry-run
```

Pendências antes de rodar de verdade:

1. **Definir `SOURCE_ORG_ID` real** — a org-fonte de onde clonar o
   orquestrador + agentes jurídicos.
2. **Executar em produção** exige `CONFIRMO` explícito do Doc (o script não
   roda contra prod por conta própria).
3. **WhatsApp** — criar o canal Zappfy manualmente pela UI da org nova depois
   do provisionamento (auto-registra o webhook).

## Reuso para o Aquecia (multi-tenant self-service)

`TenantProvisioningService` é injetável e já isola os pontos de extensão
(comentários `AQUECIA:`):

- **Endpoint**: `ProvisioningController` (`POST /admin/tenants`) com guard de
  super-admin/reseller, registrando `ProvisioningModule` no `AppModule`.
- **Billing**: gate de plano/quota antes de qualquer escrita.
- **Account/Reseller**: vincular o tenant a uma conta (ex.: `account_id` em
  `settings`) e usar um "system user" como inviter.
- **Remap de pipelines**: quando o Aquecia clonar pipelines junto, desligar
  `resetPipelineScope` e traduzir os IDs.

## Testes

```bash
yarn jest src/modules/provisioning
```

- `agent-clone.planner.spec.ts` — filtro, cópia de campos, remap de hierarquia (puro).
- `tenant-provisioning.service.spec.ts` — fluxo create + remap + idempotência (Prisma mockado).
