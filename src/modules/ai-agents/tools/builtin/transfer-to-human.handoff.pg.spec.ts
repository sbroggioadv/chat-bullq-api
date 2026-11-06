import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';
import { NotificationsService } from '../../../notifications/notifications.service';
import { PendingActionService } from '../../confirmations/pending-action.service';
import { GroupNotifyService } from '../client-ops/group-notify.service';
import { ToolContext } from '../tool.types';
import { TransferToHumanTool } from './transfer-to-human.tool';

const url = process.env.HANDOFF_PG_URL;
const suite = url ? describe : describe.skip;

suite('Chamado de grupo no PostgreSQL local descartável', () => {
  let db: PrismaClient;
  let tool: TransferToHumanTool;
  const prefix = `synthetic-handoff-${process.pid}-${Date.now()}`;
  const organizationId = `${prefix}-org`;
  const assigneeUserId = `${prefix}-user`;
  const channelId = `${prefix}-channel`;
  const contactId = `${prefix}-contact`;
  const agentId = `${prefix}-agent`;
  const groupNotify = { notifyGroupByJid: jest.fn().mockResolvedValue({ sent: true }) };
  const notifications = { notify: jest.fn().mockResolvedValue({}) };
  const pending = { create: jest.fn().mockResolvedValue({ id: `${prefix}-pending` }) };
  const realtime = { emitToConversation: jest.fn() };
  let sequence = 0;

  beforeAll(async () => {
    const target = new URL(url!);
    if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/handoff') {
      throw new Error('Use apenas o banco local descartável handoff');
    }
    db = new PrismaClient({ datasources: { db: { url } } });
    await db.organization.create({ data: {
      id: organizationId, name: 'Synthetic', slug: organizationId,
      settings: { aiHandoff: { assigneeUserId, notifyGroupJid: 'synthetic@g.us', notifyLine: 'Responsável sintético, assuma.' } },
    } });
    await db.user.create({ data: { id: assigneeUserId, name: 'Synthetic', email: `${prefix}@example.test`, password: 'synthetic' } });
    await db.userOrganization.create({ data: { userId: assigneeUserId, organizationId } });
    await db.channel.create({ data: { id: channelId, organizationId, name: 'Synthetic', type: 'WHATSAPP_ZAPPFY', config: {} } });
    await db.contact.create({ data: { id: contactId, organizationId, name: 'Grupo sintético' } });
    await db.aiAgent.create({ data: { id: agentId, organizationId, name: 'Synthetic', modelId: 'synthetic', systemPrompt: 'Synthetic' } });
    tool = new TransferToHumanTool(
      realtime as unknown as RealtimeGateway,
      pending as unknown as PendingActionService,
      db as PrismaService,
      groupNotify as unknown as GroupNotifyService,
      notifications as unknown as NotificationsService,
    );
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => { await db?.$disconnect(); });

  const create = (aiEnabled?: boolean, assignedToId?: string) => db.conversation.create({ data: {
    id: `${prefix}-conversation-${++sequence}`, organizationId, channelId, contactId,
    isGroup: true, activeAgentId: agentId, assignedToId,
    ...(aiEnabled === undefined ? {} : { aiEnabled }),
  } });
  const context = (conversationId: string): ToolContext => ({
    organizationId, conversationId, channelId, contactId, agentId, runId: `${prefix}-run`,
  });

  it.each([undefined, true])('pausa, atribui e avisa com ai_enabled=%s', async (state) => {
    const before = await create(state);
    expect(before.aiEnabled).toBe(state === undefined ? null : true);
    expect(before.activeAgentId).toBe(agentId);
    const result = await tool.execute({ reason: 'Pedido sintético' }, context(before.id));
    const after = await db.conversation.findUniqueOrThrow({ where: { id: before.id } });
    expect(after).toEqual(expect.objectContaining({ aiEnabled: false, assignedToId: assigneeUserId, activeAgentId: null }));
    expect(result.output).toEqual(expect.objectContaining({ ok: true, status: 'transferred', notified: true }));
    expect(result.output).not.toHaveProperty('alreadyTransferred');
    expect(groupNotify.notifyGroupByJid).toHaveBeenCalledTimes(1);
    expect(groupNotify.notifyGroupByJid).toHaveBeenCalledWith(expect.objectContaining({ organizationId, currentConversationId: before.id, groupJid: 'synthetic@g.us' }));
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ organizationId, recipientId: assigneeUserId }));
    expect(pending.create).not.toHaveBeenCalled();
  });

  it('confirma pausa existente com dono sem alterar a linha ou avisar', async () => {
    const before = await create(false, assigneeUserId);
    const result = await tool.execute({ reason: 'Pedido sintético' }, context(before.id));
    expect(await db.conversation.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
    expect(result.output).toEqual(expect.objectContaining({ alreadyTransferred: true }));
    expect(groupNotify.notifyGroupByJid).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(pending.create).not.toHaveBeenCalled();
  });

  it('atribui pausa sem dono e avisa uma vez sem alreadyTransferred', async () => {
    const before = await create(false);
    expect(before.assignedToId).toBeNull();
    const result = await tool.execute({ reason: 'Pedido sintético' }, context(before.id));
    const after = await db.conversation.findUniqueOrThrow({ where: { id: before.id } });
    expect(after).toEqual({ ...before, assignedToId: assigneeUserId, updatedAt: expect.any(Date) });
    expect(result.output).toEqual(expect.objectContaining({ ok: true, status: 'transferred', notified: true }));
    expect(result.output).not.toHaveProperty('alreadyTransferred');
    expect(groupNotify.notifyGroupByJid).toHaveBeenCalledTimes(1);
    expect(groupNotify.notifyGroupByJid).toHaveBeenCalledWith(expect.objectContaining({ organizationId, currentConversationId: before.id, groupJid: 'synthetic@g.us' }));
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ organizationId, recipientId: assigneeUserId }));
    expect(pending.create).not.toHaveBeenCalled();
  });

  it('controle negativo: filtro antigo não encontra NULL e filtro novo encontra', async () => {
    const conversation = await create();
    expect(conversation.aiEnabled).toBeNull();
    const where = { id: conversation.id, organizationId };
    const data = { aiEnabled: false };
    const oldFilter = await db.conversation.updateMany({ where: { ...where, aiEnabled: { not: false } }, data });
    expect(oldFilter.count).toBe(0);
    expect((await db.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).aiEnabled).toBeNull();
    const newFilter = await db.conversation.updateMany({ where: { ...where, OR: [{ aiEnabled: null }, { aiEnabled: true }] }, data });
    expect(newFilter.count).toBe(1);
    expect((await db.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).aiEnabled).toBe(false);
  });

  it('chamados concorrentes pausam e avisam apenas uma vez', async () => {
    const conversation = await create();
    const results = await Promise.all([
      tool.execute({ reason: 'Pedido sintético' }, context(conversation.id)),
      tool.execute({ reason: 'Pedido sintético' }, context(conversation.id)),
    ]);
    expect(results.map(result => result.output)).toEqual(expect.arrayContaining([
      expect.objectContaining({ notified: true }), expect.objectContaining({ alreadyTransferred: true }),
    ]));
    expect(groupNotify.notifyGroupByJid).toHaveBeenCalledTimes(1);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(pending.create).not.toHaveBeenCalled();
  });
});
