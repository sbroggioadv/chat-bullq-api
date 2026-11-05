import { Test } from '@nestjs/testing';
import { TransferToHumanTool } from './transfer-to-human.tool';
import { PrismaService } from '../../../../database/prisma.service';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';
import { PendingActionService } from '../../confirmations/pending-action.service';
import { GroupNotifyService } from '../client-ops/group-notify.service';
import { NotificationsService } from '../../../notifications/notifications.service';
import { NotificationsModule } from '../../../notifications/notifications.module';
import { ToolsModule } from '../tools.module';

it('resolve dependências do chamado e importa NotificationsModule sem retorno a ToolsModule', async () => {
  expect(Reflect.getMetadata('imports', ToolsModule)).toContain(NotificationsModule);
  expect(Reflect.getMetadata('imports', NotificationsModule)).not.toContain(ToolsModule);
  const module = await Test.createTestingModule({
    providers: [TransferToHumanTool, ...[PrismaService, RealtimeGateway, PendingActionService, GroupNotifyService, NotificationsService].map(provide => ({ provide, useValue: {} }))],
  }).compile();
  expect(module.get(TransferToHumanTool)).toBeInstanceOf(TransferToHumanTool);
  await module.close();
});
