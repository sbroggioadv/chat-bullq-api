import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { PrismaService } from '../../database/prisma.service';
import { conversationNotificationState } from './conversation-mute';

@Processor('notifications', { concurrency: 10 })
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(private readonly realtimeGateway: RealtimeGateway, private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job): Promise<any> {
    const { notificationId, recipientId, organizationId, type, title, body, data } = job.data;
    if (type === 'NEW_MESSAGE' && (await conversationNotificationState(this.prisma, organizationId, data?.conversationId, this.logger)).suppressNotifications) {
      return { delivered: false, reason: 'conversation_muted', channels: [] };
    }

    this.realtimeGateway.emitToUserInOrg(recipientId, organizationId, 'notification:new', {
      id: notificationId,
      recipientId,
      type,
      title,
      body,
      data,
      createdAt: new Date().toISOString(),
    });

    this.logger.log(`Notification delivered via WS: ${notificationId} to user:${recipientId}`);

    return { delivered: true, channels: ['in-app'] };
  }
}
