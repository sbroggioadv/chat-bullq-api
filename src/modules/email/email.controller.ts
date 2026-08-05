import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import {
  CurrentChannelAccess,
  CurrentOrg,
} from '../../common/decorators';
import type { ChannelAccess } from '../iam/channel-access/channel-access.service';
import { EmailService } from './email.service';

@ApiTags('Email')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('email')
export class EmailController {
  constructor(private readonly email: EmailService) {}

  @Get('status')
  @ApiOperation({
    summary:
      'Canais GMAIL acessíveis ao usuário na org — alimenta o item E-mail da sidebar.',
  })
  status(
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.email.status(orgId, access);
  }

  @Get('folders')
  @ApiOperation({
    summary:
      'Pastas sistema (Caixa/Enviados/Spam) + labels user da conta Gmail do canal (readonly).',
  })
  folders(
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Query('channelId') channelId?: string,
  ) {
    return this.email.folders(orgId, access, channelId);
  }

  @Get('threads')
  @ApiOperation({
    summary: 'Lista threads de uma pasta/label via Gmail threads.list.',
  })
  threads(
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Query('channelId') channelId?: string,
    @Query('folderId') folderId?: string,
    @Query('pageToken') pageToken?: string,
    @Query('limit') limit?: string,
  ) {
    return this.email.threads(
      orgId,
      access,
      channelId,
      folderId || 'INBOX',
      pageToken,
      limit,
    );
  }

  @Get('threads/:threadId')
  @ApiOperation({ summary: 'Detalhe de um thread (mensagens completas).' })
  thread(
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Param('threadId') threadId: string,
    @Query('channelId') channelId?: string,
  ) {
    return this.email.thread(orgId, access, channelId, threadId);
  }
}
