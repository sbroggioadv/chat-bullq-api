import { PrismaService } from '../../database/prisma.service';

export async function conversationNotificationState(prisma: PrismaService, organizationId: string, conversationId: unknown) {
  if (typeof conversationId !== 'string' || !conversationId) {
    return { mutedUntil: null, suppressNotifications: false };
  }
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, organizationId }, select: { mutedUntil: true } });
  const mutedUntil = conversation?.mutedUntil ?? null;
  return { mutedUntil: mutedUntil?.toISOString() ?? null, suppressNotifications: !!mutedUntil && mutedUntil.getTime() > Date.now() };
}
