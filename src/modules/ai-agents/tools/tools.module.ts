import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../../database/prisma.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { ReplyToConversationTool } from './builtin/reply-to-conversation.tool';
import { TransferToHumanTool } from './builtin/transfer-to-human.tool';
import { TagConversationTool } from './builtin/tag-conversation.tool';
import { ToolRegistry } from './tool-registry.service';

@Module({
  imports: [
    PrismaModule,
    RealtimeModule,
    BullModule.registerQueue({ name: 'outbound-messages' }),
  ],
  providers: [
    ReplyToConversationTool,
    TransferToHumanTool,
    TagConversationTool,
    ToolRegistry,
  ],
  exports: [ToolRegistry],
})
export class ToolsModule {}
