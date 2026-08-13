import { ChannelType, ConversationStatus, MessageDirection } from '@prisma/client';
import { JarvisDeskTools } from './jarvis-desk.tools';
import type { PrismaService } from '../../database/prisma.service';
import type { WatchdogConfigService } from '../routing/watchdog/watchdog-config.service';

function makeTools() {
  const count = jest.fn();
  const findMany = jest.fn();
  const findFirst = jest.fn();
  const findUnique = jest.fn();
  const prisma = {
    conversation: { count, findMany, findFirst },
    message: { count },
    organization: { findUnique },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  } as unknown as PrismaService;
  const watchdogConfig = {
    resolve: () => ({
      delayBotMin: 5,
      delayPendingMin: 10,
      delayHumanIdleMin: 20,
      maxAttempts: 3,
    }),
  } as unknown as WatchdogConfigService;
  return {
    tools: new JarvisDeskTools(prisma, watchdogConfig),
    count,
    findMany,
    findFirst,
    findUnique,
  };
}

describe('JarvisDeskTools', () => {
  it('inbox_overview devolve snapshot e não consulta canal JARVIS', async () => {
    const { tools, count } = makeTools();
    count.mockResolvedValue(2);
    const result = await tools.inboxOverview('org1');
    expect(result.open).toBe(2);
    expect(result.stuck).toBe(2);
    const firstWhere = count.mock.calls[0][0].where;
    expect(firstWhere.channel.type.in).toContain(ChannelType.WHATSAPP_ZAPPFY);
    expect(firstWhere.channel.type.in).not.toContain(ChannelType.JARVIS);
  });

  it('list_conversations filtra sem resposta pelo último inbound antigo', async () => {
    const { tools, findMany } = makeTools();
    const old = new Date(Date.now() - 45 * 60_000);
    findMany.mockResolvedValue([
      {
        id: 'c1',
        status: ConversationStatus.OPEN,
        protocol: 'P1',
        isStuck: false,
        lastMessageAt: old,
        assignedTo: null,
        activeAgent: null,
        contact: { name: 'Maria', phone: '1' },
        channel: { name: 'WA', type: ChannelType.WHATSAPP_ZAPPFY },
        messages: [
          {
            direction: MessageDirection.INBOUND,
            createdAt: old,
            type: 'TEXT',
            content: { text: 'oi' },
          },
        ],
      },
      {
        id: 'c2',
        status: ConversationStatus.OPEN,
        protocol: 'P2',
        isStuck: false,
        lastMessageAt: new Date(),
        assignedTo: null,
        activeAgent: null,
        contact: { name: 'João', phone: '2' },
        channel: { name: 'WA', type: ChannelType.WHATSAPP_ZAPPFY },
        messages: [
          {
            direction: MessageDirection.OUTBOUND,
            createdAt: new Date(),
            type: 'TEXT',
            content: { text: 'já respondi' },
          },
        ],
      },
    ]);
    const rows = (await tools.listConversations('org1', {
      unansweredMinutes: 30,
    })) as Array<{ conversationId: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].conversationId).toBe('c1');
  });

  it('get_conversation recusa id vazio', async () => {
    const { tools } = makeTools();
    await expect(tools.getConversation('org1', '')).resolves.toEqual({
      error: 'conversationId obrigatório',
    });
  });
});
