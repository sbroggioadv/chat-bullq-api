import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import {
  CurrentChannelAccess,
  CurrentOrg,
} from '../../common/decorators';
import type { ChannelAccess } from '../iam/channel-access/channel-access.service';
import { EmailService } from './email.service';

class EmailReplyDto {
  @ApiProperty()
  @IsString()
  channelId!: string;

  @ApiProperty()
  @IsString()
  threadId!: string;

  @ApiProperty({ description: 'Corpo texto puro da resposta' })
  @IsString()
  @MinLength(1)
  body!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  to?: string;

  @ApiPropertyOptional({ description: 'Cc (vírgula). Ignorado se replyAll=true.' })
  @IsOptional()
  @IsString()
  cc?: string;

  @ApiPropertyOptional({
    description: 'Responder a todos (To=From, Cc=To+Cc originais sem o remetente)',
  })
  @IsOptional()
  @IsBoolean()
  replyAll?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subject?: string;
}

class EmailForwardDto {
  @ApiProperty()
  @IsString()
  channelId!: string;

  @ApiProperty()
  @IsString()
  threadId!: string;

  @ApiProperty({ description: 'Destinatários separados por vírgula' })
  @IsString()
  @MinLength(3)
  to!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  body?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subject?: string;
}

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

  @Post('reply')
  @ApiOperation({
    summary:
      'Responde um thread Gmail (exige scope gmail.send no token do canal).',
  })
  reply(
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Body() dto: EmailReplyDto,
  ) {
    return this.email.reply(orgId, access, dto);
  }

  @Post('forward')
  @ApiOperation({ summary: 'Encaminha um thread Gmail para novos destinatários.' })
  forward(
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Body() dto: EmailForwardDto,
  ) {
    return this.email.forward(orgId, access, dto);
  }
}
