import { AiAgentRunnerService } from './agent-runner.service';

describe('resolução de skills por organização', () => {
  it('ignora skill e tool alheias e preserva skill e tool do dono', async () => {
    const makeSkill = (name: string, organizationId: string, toolOrg: string) => ({ name, organizationId, isActive: true, deletedAt: null, source: 'HTTP', description: name, parameters: {}, promptInstructions: name, tool: { organizationId: toolOrg } });
    const links = [
      { agent: { organizationId: 'org-b' }, skill: makeSkill('alheia', 'org-a', 'org-a') },
      { agent: { organizationId: 'org-b' }, skill: makeSkill('tool-alheia', 'org-b', 'org-a') },
      { agent: { organizationId: 'org-b' }, skill: makeSkill('propria', 'org-b', 'org-b') },
    ];
    const svc = Object.create(AiAgentRunnerService.prototype) as any;
    svc.prisma = { aiAgentSkill: { findMany: jest.fn().mockResolvedValue(links) } };
    svc.registry = { getLlmDefinitionsForKind: () => [] };
    svc.logger = { warn: jest.fn() };
    const result = await svc.resolveToolsAndSkills('agente-b', 'WORKER');
    expect(result.skillInstructions).toEqual(['tool-alheia', 'propria']);
    expect([...result.customSkillsByName.keys()]).toEqual(['propria']);
  });
});
