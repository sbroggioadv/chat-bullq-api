import { Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

const logger = new Logger('ConversationMute');

export async function conversationNotificationState(prisma: PrismaService, organizationId: string, conversationId: unknown, warningLogger: Pick<Logger, 'warn'> = logger) {
  if (typeof conversationId !== 'string' || !conversationId) {
    return { mutedUntil: null, suppressNotifications: false };
  }
  try {
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, organizationId }, select: { mutedUntil: true } });
    const mutedUntil = conversation?.mutedUntil ?? null;
    return { mutedUntil: mutedUntil?.toISOString() ?? null, suppressNotifications: !!mutedUntil && mutedUntil.getTime() > Date.now() };
  } catch {
    // O silêncio é opcional; falhar nesta leitura não pode perder a entrega.
    warningLogger.warn({ msg: 'conversation_mute_lookup_failed', conversationId, organizationId });
    return { mutedUntil: null, suppressNotifications: false };
  }
}
