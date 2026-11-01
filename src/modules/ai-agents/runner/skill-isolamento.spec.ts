import { AiAgentRunnerService } from './agent-runner.service';

describe('resolução de skills por organização', () => {
  const makeSkill = (name: string, organizationId: string, toolOrg: string) => ({ name, organizationId, isActive: true, deletedAt: null, source: 'HTTP', description: name, parameters: {}, promptInstructions: name, tool: { organizationId: toolOrg } });
  const resolve = async (skill: ReturnType<typeof makeSkill>) => {
    const links = [skill, makeSkill('propria', 'org-b', 'org-b')].map((entry) => ({ agent: { organizationId: 'org-b' }, skill: entry }));
    const svc = Object.create(AiAgentRunnerService.prototype) as any;
    svc.prisma = { aiAgentSkill: { findMany: jest.fn().mockResolvedValue(links) } };
    svc.registry = { getLlmDefinitionsForKind: () => [] };
    svc.logger = { warn: jest.fn() };
    return svc.resolveToolsAndSkills('agente-b', 'WORKER');
  };

  it('ignora skill alheia e preserva skill própria', async () => {
    const result = await resolve(makeSkill('alheia', 'org-a', 'org-a'));
    expect(result.skillInstructions).toEqual(['propria']);
    expect([...result.customSkillsByName.keys()]).toEqual(['propria']);
  });

  it('ignora tool alheia e preserva tool própria', async () => {
    const result = await resolve(makeSkill('tool-alheia', 'org-b', 'org-a'));
    expect([...result.customSkillsByName.keys()]).toEqual(['propria']);
    expect(result.skillInstructions).toEqual(['tool-alheia', 'propria']);
  });
});
