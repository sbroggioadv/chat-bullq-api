import { ChannelType } from '@prisma/client';
import { JarvisDeskService } from './jarvis-desk.service';
import type { PrismaService } from '../../database/prisma.service';

describe('JarvisDeskService.ensureDesk', () => {
  it('reusa canal e conversa existentes (idempotente)', async () => {
    const prisma = {
      channel: {
        findFirst: jest.fn().mockResolvedValue({ id: 'ch1' }),
        create: jest.fn(),
      },
      contactChannel: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ contact: { id: 'ct1' } }),
      },
      contact: { create: jest.fn() },
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'cv1' }),
        create: jest.fn(),
        update: jest.fn(),
      },
      message: { create: jest.fn() },
    } as unknown as PrismaService;

    const desk = await new JarvisDeskService(prisma).ensureDesk('org1');
    expect(desk).toEqual({
      channelId: 'ch1',
      conversationId: 'cv1',
      contactId: 'ct1',
    });
    expect(prisma.channel.create).not.toHaveBeenCalled();
    expect(prisma.conversation.create).not.toHaveBeenCalled();
  });

  it('reconhece ChannelType.JARVIS', () => {
    const svc = new JarvisDeskService({} as PrismaService);
    expect(svc.isJarvisChannel(ChannelType.JARVIS)).toBe(true);
    expect(svc.isJarvisChannel(ChannelType.GMAIL)).toBe(false);
  });
});
