import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../database/prisma.service';

/**
 * Limpeza diária dos AiResponseLog mais antigos que 7 dias.
 * Logs além disso não importam pras queries de rate-limit (janela rolante
 * de 1h), então mantê-los só infla a tabela sem benefício.
 *
 * Roda 03:00 BRT (config padrão do server timezone).
 */
@Injectable()
export class AiResponseLogCleanupService {
  private readonly logger = new Logger(AiResponseLogCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanup(): Promise<void> {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await this.prisma.aiResponseLog.deleteMany({
      where: { sentAt: { lt: cutoff } },
    });
    this.logger.log(`AiResponseLog cleanup: removed ${result.count} logs older than ${cutoff.toISOString()}`);
  }
}
