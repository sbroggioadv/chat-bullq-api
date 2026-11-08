# Pendências — API-1 / SPEC-023

## Gate de lint preexistente, sem decisão estrutural tomada

`yarn lint --no-fix` retornou exit 1: `error Command "lint" not found.` O `package.json` não declara script lint, não há configuração ESLint/Biome no checkout e não há executável ESLint nas dependências instaladas. O roadmap local já registra a introdução de lint na trilha T2.

O setor não alterou dependências nem criou configuração paralela de lint. O integrador precisa encaminhar o gate canônico de lint antes de declarar prontidão integral. Tipos e testes locais foram executados separadamente; seu sucesso não substitui lint.

## Dependências de integração

- WEB-1 consome as rotas de F1/F4/F8 e seleciona comment/attachment em F9. Os pedidos e respostas estão no cross-requests.md do workspace pai.
- O executor não declara aceite visual nem revisão independente. Essas etapas são do integrador e de QA conforme a SPEC.
- Aplicação do SQL e deploy permanecem nas etapas autorizativas da SPEC, sem execução neste setor.

Não surgiu decisão estrutural indispensável para implementar os contratos aprovados. Nenhuma aprovação foi simulada ou alegada como roteada.
