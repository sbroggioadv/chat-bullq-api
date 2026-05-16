-- Migration de recuperação: adiciona colunas do organograma matricial que
-- estavam no schema.prisma mas nunca foram propagadas como migration formal.
-- Provável regressão do merge upstream JP de 2026-05-13 (43 commits) — alguém
-- rodou `prisma db push` em dev local mas esqueceu `migrate dev`, então o
-- schema do client (TS) tinha os campos mas o DB de prod não.
-- Sintoma: POST /api/v1/ai-agents retornava 500 "Internal server error" porque
-- Prisma tentava INSERT em colunas inexistentes.
-- Operação 100% aditiva: ADD COLUMN nullable + FK self-reference + 1 index.
-- Não toca dados existentes, não bloqueia, não precisa downtime.

-- ─── Organograma matricial ágil ─────────────────────────────────
-- parent_agent_id: chefia direta (self-FK). NULL = raiz/CEO virtual.
-- department: setor da empresa (string livre, UI sugere VENDAS/SUPORTE/CS/etc).
-- squad: time multi-funcional ortogonal ao departamento.
-- operational_context: texto vivo injetado no system prompt em todo run.
-- operational_context_updated_at: timestamp da última edição do contexto vivo.

ALTER TABLE "ai_agents"
  ADD COLUMN "parent_agent_id" TEXT,
  ADD COLUMN "department" TEXT,
  ADD COLUMN "squad" TEXT,
  ADD COLUMN "operational_context" TEXT,
  ADD COLUMN "operational_context_updated_at" TIMESTAMP(3);

-- Self-FK pra hierarquia parent→child. ON DELETE SET NULL pra não cascatear
-- exclusão do chefe (subordinados viram órfãos no nível anterior, não somem).
ALTER TABLE "ai_agents"
  ADD CONSTRAINT "ai_agents_parent_agent_id_fkey"
  FOREIGN KEY ("parent_agent_id") REFERENCES "ai_agents"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Index pra queries de "listar subordinados de X" e walks de ancestralidade
-- (anti-ciclo do AgentsService.isDescendantOf).
CREATE INDEX "ai_agents_parent_agent_id_idx" ON "ai_agents"("parent_agent_id");
