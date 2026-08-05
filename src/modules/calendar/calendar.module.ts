import { Module } from '@nestjs/common';
import { ChannelAccessModule } from '../iam/channel-access/channel-access.module';
import { GmailModule } from '../channel-hub/adapters/gmail/gmail.module';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';

@Module({
  imports: [ChannelAccessModule, GmailModule],
  controllers: [CalendarController],
  providers: [CalendarService],
  exports: [CalendarService],
})
export class CalendarModule {}
