import { NotFoundException } from '@nestjs/common';
import { AutomationsService } from './automations.service';

const rule = (field: string, value: unknown) => ({ match: 'AND', groups: [{ match: 'AND', rules: [{ field, op: 'equals', value }] }] });
describe('fronteira de referências de automação', () => {
  const lookup = jest.fn(async ({ where }: any) => (where.id ?? where.userId) === 'proprio' ? { id: 'proprio' } : null);
  const prisma: any = { tag: { findFirst: lookup }, pipeline: { findFirst: lookup }, pipelineStage: { findFirst: lookup }, userOrganization: { findFirst: lookup }, channel: { findFirst: lookup }, contact: { findFirst: lookup }, conversation: { findFirst: lookup }, automation: { count: jest.fn().mockResolvedValue(0), create: jest.fn().mockResolvedValue({ ok: true }), update: jest.fn().mockResolvedValue({ ok: true }), findFirst: jest.fn() } };
  const validator: any = { validateActions: (x: any) => x, validateConditions: (_: any, x: any) => x ?? {} };
  const service = new AutomationsService(prisma, validator, {} as any, {} as any);
  const create = (actions: any, conditions: any = {}) => service.create('espaco', 'ator', { name: 'teste', trigger: 'TAG_ADDED' as any, actions, conditions });
  beforeEach(() => { jest.clearAllMocks(); prisma.automation.findFirst.mockResolvedValue({ trigger: 'TAG_ADDED', actions: [{ type: 'add_tag', params: { tagId: 'apagado' } }], conditions: rule('tagId', 'apagado') }); });
  it.each(['tagId', 'pipelineId', 'stageId', 'toStageId', 'userId'])('recusa ação com %s alheio e inexistente', async (field) => {
    for (const id of ['alheio', 'inexistente']) await expect(create([{ type: 'teste', params: { [field]: id } }])).rejects.toThrow(NotFoundException);
    await expect(create([{ type: 'teste', params: { [field]: 'proprio' } }])).resolves.toEqual({ ok: true });
  });
  it.each(['tagId', 'channelId', 'contactId', 'conversationId', 'fromAssigneeId', 'toAssigneeId'])('valida condição %s, inclusive lista', async (field) => {
    await expect(create([], rule(field, ['proprio', 'alheio']))).rejects.toThrow(NotFoundException);
    await expect(create([], rule(field, 'proprio'))).resolves.toEqual({ ok: true });
  });
  it('edição preserva id apagado inalterado e recusa id novo', async () => {
    await expect(service.update('regra', 'espaco', { name: 'novo', enabled: true })).resolves.toEqual({ ok: true });
    await expect(service.update('regra', 'espaco', { actions: [{ type: 'add_tag', params: { tagId: 'apagado' } }], conditions: rule('tagId', 'apagado') })).resolves.toEqual({ ok: true });
    await expect(service.update('regra', 'espaco', { actions: [{ type: 'add_tag', params: { tagId: 'alheio' } }] })).rejects.toThrow(NotFoundException);
  });
});
