import { AiAgent } from '@prisma/client';

export function isConversationalOrchestrator(agent: Pick<AiAgent, 'kind' | 'canRespondDirectly'>): boolean {
  return agent.kind === 'ORCHESTRATOR' && agent.canRespondDirectly === true;
}
