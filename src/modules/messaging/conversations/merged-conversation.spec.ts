import { readFileSync } from 'fs';
import { join } from 'path';
import { UnprocessableEntityException } from '@nestjs/common';
import {
  MergedConversationError,
  mergedOriginalId,
  throwIfMergedExtra,
} from './merged-conversation';
import { SendMessageHandler } from '../../automations/actions/handlers/send-message.handler';
import { ChatbotProcessor } from '../../chatbot/engine/chatbot.processor';
import { MessagesService } from '../messages/messages.service';
import { ReplyToConversationTool } from '../../ai-agents/tools/builtin/reply-to-conversation.tool';
import { DelegateToAgentTool } from '../../ai-agents/tools/builtin/delegate-to-agent.tool';
import { OutboundMessageProcessor } from '../pipeline/outbound-message.processor';
import { CalendarService } from '../../calendar/calendar.service';

// Extra FUNDIDA pela limpeza (metadata.cleanup_merged_into) não envia nem
// grava mensagem de saída. Conversa só ARQUIVADA pelo usuário continua
// aceitando envio — o usuário pode responder numa conversa que arquivou.

const FUNDIDA = { cleanup_merged_into: 'original', cleanup_run: 'run-1' };
const queue = () => ({ add: jest.fn().mockResolvedValue(undefined) });

describe('mergedOriginalId', () => {
  it.each([
    [null, null],
    [undefined, null],
    [{}, null],
    [[], null],
    [{ cleanup_merged_into: '' }, null],
    [{ cleanup_merged_into: 42 }, null],
    [{ imported: true, externalConversationId: 'jid' }, null],
    [FUNDIDA, 'original'],
  ])('%j → %j', (metadata, esperado) => {
    expect(mergedOriginalId(metadata)).toBe(esperado);
  });
});

describe('throwIfMergedExtra — leitura comum antes de gravar mensagem que entra', () => {
  // O fake só tem findUnique: SQL cru ($queryRaw com FOR SHARE/UPDATE) quebraria aqui.
  const db = (metadata: unknown) => ({ conversation: { findUnique: jest.fn().mockResolvedValue(metadata === undefined ? null : { metadata }) } });

  it('conversa sem a marca (inclusive arquivada à mão) → segue, com um findUnique comum', async () => {
    const d = db({ imported: true });

    await expect(throwIfMergedExtra(d as any, 'conv')).resolves.toBeUndefined();
    expect(d.conversation.findUnique).toHaveBeenCalledWith({ where: { id: 'conv' }, select: { metadata: true } });
  });

  it('extra fundida → MergedConversationError (nada é gravado pelo chamador)', async () => {
    await expect(throwIfMergedExtra(db(FUNDIDA) as any, 'extra')).rejects.toBeInstanceOf(MergedConversationError);
  });

  it('conversa inexistente → não é extra fundida (a gravação falha depois pela FK, como antes)', async () => {
    await expect(throwIfMergedExtra(db(undefined) as any, 'sumiu')).resolves.toBeUndefined();
  });
});

describe('caminho de gravação da mensagem que entra NÃO usa lock de linha (deadlock entre inbounds)', () => {
  // Dois inbounds da mesma conversa com FOR SHARE seguido de UPDATE se
  // bloqueiam mutuamente (parecer-revisor-api-2, item 4). Sem lock explícito,
  // o INSERT da mensagem pega só FOR KEY SHARE (FK), compatível com o UPDATE.
  const semComentarios = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  it.each([
    'merged-conversation.ts',
    '../pipeline/inbound-message.processor.ts',
    '../pipeline/history-import.service.ts',
    '../pipeline/conversation-resolver.service.ts',
  ])('%s não tem FOR SHARE / FOR UPDATE / FOR NO KEY UPDATE / FOR KEY SHARE', (arquivo) => {
    const codigo = semComentarios(readFileSync(join(__dirname, arquivo), 'utf8'));

    expect(codigo).not.toMatch(/\bFOR\s+(NO\s+KEY\s+UPDATE|KEY\s+SHARE|SHARE|UPDATE)\b/i);
  });
});

describe('automação send_message', () => {
  function run(metadata: unknown, extra: Record<string, unknown> = {}) {
    const q = queue();
    const prisma = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'conv', channelId: 'ch', metadata, ...extra,
          contact: { channels: [{ channelId: 'ch', externalId: 'ext' }] },
        }),
      },
      message: { create: jest.fn().mockResolvedValue({ id: 'msg' }) },
    };
    const handler = new SendMessageHandler(q as any);
    const result = handler.execute({ body: 'oi' }, { organizationId: 'org', payload: { conversationId: 'conv' }, prisma, actorId: null, traceId: 't' } as any);
    return { result, prisma, q };
  }

  it('extra fundida → não grava nem enfileira, devolve conversation_merged', async () => {
    const { result, prisma, q } = run(FUNDIDA);

    await expect(result).resolves.toMatchObject({ ok: false, errorCode: 'conversation_merged' });
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(q.add).not.toHaveBeenCalled();
  });

  it('arquivada à mão (sem a marca da fusão) → envia normalmente', async () => {
    const { result, prisma, q } = run({}, { isArchived: true });

    await expect(result).resolves.toMatchObject({ ok: true });
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
    expect(q.add).toHaveBeenCalledTimes(1);
  });
});

describe('chatbot', () => {
  function run(metadata: unknown) {
    const q = queue();
    const engine = { processMessage: jest.fn().mockResolvedValue({ messages: [{ type: 'TEXT', content: { text: 'a' } }], transferToHuman: false }) };
    const prisma = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conv', metadata }) },
      message: { create: jest.fn().mockResolvedValue({ id: 'msg' }) },
    };
    const processor = new ChatbotProcessor(engine as any, prisma as any, q as any);
    const result = processor.process({ data: { conversationId: 'conv', channelId: 'ch', contactExternalId: 'ext', organizationId: 'org', messageText: 'oi' } } as any);
    return { result, engine, prisma, q };
  }

  it('extra fundida → bot não roda, nada é gravado nem enfileirado', async () => {
    const { result, engine, prisma, q } = run(FUNDIDA);

    await expect(result).resolves.toEqual({ skipped: true, reason: 'conversation_merged' });
    expect(engine.processMessage).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(q.add).not.toHaveBeenCalled();
  });

  it('conversa sem a marca → bot responde normalmente', async () => {
    const { result, engine, q } = run({});

    await expect(result).resolves.toMatchObject({ messagesCount: 1 });
    expect(engine.processMessage).toHaveBeenCalledTimes(1);
    expect(q.add).toHaveBeenCalledTimes(1);
  });
});

describe('envio direto pela caixa (MessagesService.send)', () => {
  it('extra fundida → 422 conversation_merged, nada gravado nem enfileirado', async () => {
    const repository = { create: jest.fn() };
    const q = queue();
    const prisma = {
      conversation: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'extra', organizationId: 'org', channelId: 'ch', metadata: FUNDIDA, isArchived: true,
          channel: { type: 'WHATSAPP_ZAPPFY' }, contact: { name: 'X', channels: [{ channelId: 'ch', externalId: 'ext' }] },
        }),
      },
    };
    const service = new MessagesService(
      repository as any, prisma as any, {} as any, { assertChannelAccess: jest.fn() } as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, q as any,
    );

    const envio = service.send({ conversationId: 'extra', type: 'TEXT', content: { text: 'oi' } } as any, 'user', 'org');

    await expect(envio).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repository.create).not.toHaveBeenCalled();
    expect(q.add).not.toHaveBeenCalled();
  });
});

describe('ferramentas da IA', () => {
  const ctx = { conversationId: 'conv', agentId: 'ag', runId: 'run', contactId: 'ct', channelId: 'ch', organizationId: 'org' } as any;

  function replyTool(metadata: unknown) {
    const q = queue();
    const prisma = {
      aiAgent: { findUnique: jest.fn().mockResolvedValue({ name: 'Sofia' }) },
      contactChannel: { findFirst: jest.fn().mockResolvedValue({ externalId: 'ext' }) },
      conversation: {
        findUnique: jest.fn().mockResolvedValue({ metadata, organization: { allowedUrlDomains: null } }),
        update: jest.fn(),
      },
      message: { create: jest.fn().mockResolvedValue({ id: 'msg' }) },
    };
    const tool = new ReplyToConversationTool(prisma as any, { emitToChannel: jest.fn(), emitToConversation: jest.fn() } as any, q as any);
    return { tool, prisma, q };
  }

  it('replyToConversation em extra fundida → erro claro ao agente, nada gravado nem enfileirado', async () => {
    const { tool, prisma, q } = replyTool(FUNDIDA);

    const r = await tool.execute({ text: 'Olá, posso ajudar?' }, ctx);

    expect(r.output).toMatchObject({ ok: false, error: 'conversation_merged' });
    expect(r.finalAction).toBeUndefined();
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(q.add).not.toHaveBeenCalled();
  });

  it('replyToConversation em conversa arquivada à mão (sem a marca) → responde normalmente', async () => {
    const { tool, prisma, q } = replyTool({});

    const r = await tool.execute({ text: 'Olá, posso ajudar?' }, ctx);

    expect(r).toMatchObject({ output: { ok: true }, finalAction: 'REPLIED' });
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
    expect(q.add).toHaveBeenCalledTimes(1);
  });

  it('delegateToAgent em extra fundida → erro claro ao agente, sem transação nem envio', async () => {
    const q = queue();
    const prisma = {
      aiAgent: {
        findFirst: jest.fn().mockResolvedValue({ id: 'worker', name: 'W', kind: 'WORKER' }),
        findUnique: jest.fn().mockResolvedValue({ name: 'Orq' }),
      },
      contactChannel: { findFirst: jest.fn().mockResolvedValue({ externalId: 'ext' }) },
      conversation: { findUnique: jest.fn().mockResolvedValue({ metadata: FUNDIDA }), update: jest.fn() },
      $transaction: jest.fn(),
    };
    const tool = new DelegateToAgentTool(prisma as any, { emitToChannel: jest.fn(), emitToConversation: jest.fn() } as any, q as any);

    const r = await tool.execute({ agentId: 'worker', reason: 'r', transitionMessage: 'vou te passar' }, ctx);

    expect(r.output).toMatchObject({ ok: false, error: 'conversation_merged' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(q.add).not.toHaveBeenCalled();
  });
});

describe('calendário (createEventFromConversation)', () => {
  it('extra fundida → 422 antes de criar o evento externo e a mensagem local', async () => {
    const prisma = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'extra', channelId: 'ch', metadata: FUNDIDA }), update: jest.fn() },
      message: { create: jest.fn() },
    };
    const service = new CalendarService(prisma as any, { assertChannelAccess: jest.fn() } as any, {} as any);
    const createEvent = jest.spyOn(service, 'createEvent' as any).mockResolvedValue({ id: 'ev' } as any);

    const r = service.createEventFromConversation('org', 'ALL', { conversationId: 'extra', summary: 'Reunião', startIso: '2026-11-03T10:00:00Z', endIso: '2026-11-03T11:00:00Z' });

    await expect(r).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(createEvent).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('conversa sem a marca (inclusive arquivada à mão) → cria o evento e a mensagem local', async () => {
    const prisma = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conv', channelId: 'ch', metadata: {} }), update: jest.fn() },
      message: { create: jest.fn().mockResolvedValue({ id: 'msg' }) },
    };
    const service = new CalendarService(prisma as any, { assertChannelAccess: jest.fn() } as any, {} as any);
    jest.spyOn(service, 'createEvent' as any).mockResolvedValue({ id: 'ev', calendarId: 'cal', summary: 'Reunião' } as any);

    await service.createEventFromConversation('org', 'ALL', { conversationId: 'conv', summary: 'Reunião', startIso: '2026-11-03T10:00:00Z', endIso: '2026-11-03T11:00:00Z' });

    expect(prisma.message.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ conversationId: 'conv' }) }));
  });
});

describe('worker de saída (outbound-messages)', () => {
  function setup(metadata: unknown) {
    const update = jest.fn(async ({ data }: any) => ({ id: 'msg', conversationId: 'conv', ...data }));
    const prisma: any = {
      channel: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'ch', organizationId: 'org', type: 'WHATSAPP_ZAPPFY' }) },
      message: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ conversation: { id: 'conv', organizationId: 'org', metadata } }),
        findUnique: jest.fn().mockResolvedValue({ metadata: {}, conversationId: 'conv' }),
        update,
      },
    };
    const adapter = { sendMessage: jest.fn().mockResolvedValue({ externalId: 'wamid' }) };
    const gateway = { emitToConversation: jest.fn(), emitToChannel: jest.fn() };
    const processor = new OutboundMessageProcessor(prisma, { getOutbound: () => adapter } as any, gateway as any, { markProcessed: jest.fn() } as any);
    const job: any = { data: { messageId: 'msg', channelId: 'ch', contactExternalId: 'ext', message: { type: 'TEXT', content: { text: 'oi' } } } };
    return { processor, adapter, update, job };
  }

  it('job antigo de extra fundida → não entrega, marca FAILED e conclui sem retry (sem throw)', async () => {
    const { processor, adapter, update, job } = setup(FUNDIDA);

    await expect(processor.process(job)).resolves.toEqual({ success: false, reason: 'conversation_merged' });
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ where: { id: 'msg' }, data: { status: 'FAILED', failedReason: 'conversation_merged' } });
  });

  it('conversa sem a marca (inclusive arquivada à mão) → entrega normalmente', async () => {
    const { processor, adapter, job } = setup({});

    await expect(processor.process(job)).resolves.toMatchObject({ success: true });
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
  });
});
