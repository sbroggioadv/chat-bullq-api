import { Module } from '@nestjs/common';
import { GmailHttpClient } from './gmail.http-client';
import { GmailInboundAdapter } from './gmail.inbound-adapter';
import { GmailOutboundAdapter } from './gmail.outbound-adapter';
import { GmailSyncAdapter } from './gmail.sync-adapter';

@Module({
  providers: [
    GmailHttpClient,
    GmailInboundAdapter,
    GmailOutboundAdapter,
    GmailSyncAdapter,
  ],
  exports: [
    GmailHttpClient,
    GmailInboundAdapter,
    GmailOutboundAdapter,
    GmailSyncAdapter,
  ],
})
export class GmailModule {}
