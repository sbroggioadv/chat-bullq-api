import { Module } from '@nestjs/common';
import { ChannelAccessModule } from '../iam/channel-access/channel-access.module';
import { GmailModule } from '../channel-hub/adapters/gmail/gmail.module';
import { EmailController } from './email.controller';
import { EmailService } from './email.service';

@Module({
  imports: [ChannelAccessModule, GmailModule],
  controllers: [EmailController],
  providers: [EmailService],
})
export class EmailModule {}
