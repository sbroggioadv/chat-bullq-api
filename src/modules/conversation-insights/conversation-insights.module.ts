import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { AiProvidersModule } from '../ai-agents/providers/providers.module';
import { CalendarModule } from '../calendar/calendar.module';
import { ChannelAccessModule } from '../iam/channel-access/channel-access.module';
import { ConversationInsightsController } from './conversation-insights.controller';
import { ConversationInsightsService } from './conversation-insights.service';

@Module({
  imports: [PrismaModule, ChannelAccessModule, CalendarModule, AiProvidersModule],
  controllers: [ConversationInsightsController],
  providers: [ConversationInsightsService],
})
export class ConversationInsightsModule {}
