import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import {
  CurrentChannelAccess,
  CurrentOrg,
} from '../../common/decorators';
import type { ChannelAccess } from '../iam/channel-access/channel-access.service';
import { EmailService } from './email.service';

class EmailOutboundAttachmentDto {
  @ApiProperty({ example: 'contrato.pdf' })
  @IsString()
  @MinLength(1)
  filename!: string;

  @ApiPropertyOptional({ example: 'application/pdf' })
  @IsOptional()
  @IsString()
  mimeType?: string;

  @ApiProperty({ description: 'Conteúdo base64 (std ou data-URL)' })
  @IsString()
  @MinLength(1)
  contentBase64!: string;
}

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

  @ApiPropertyOptional({
    type: [EmailOutboundAttachmentDto],
    description: 'Até 5 anexos, 8 MB cada (base64)',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EmailOutboundAttachmentDto)
  attachments?: EmailOutboundAttachmentDto[];
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

  @ApiPropertyOptional({ type: [EmailOutboundAttachmentDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EmailOutboundAttachmentDto)
  attachments?: EmailOutboundAttachmentDto[];
}

class EmailComposeDto {
  @ApiProperty()
  @IsString()
  channelId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  to!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  subject!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  body!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cc?: string;

  @ApiPropertyOptional({ type: [EmailOutboundAttachmentDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EmailOutboundAttachmentDto)
  attachments?: EmailOutboundAttachmentDto[];
}

class EmailArchiveDto {
  @ApiProperty()
  @IsString()
  channelId!: string;

  @ApiProperty()
  @IsString()
  threadId!: string;
}

class EmailModifyDto {
  @ApiProperty()
  @IsString()
  channelId!: string;

  @ApiProperty()
  @IsString()
  threadId!: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  addLabelIds?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  removeLabelIds?: string[];

  /** Atalhos: star | unstar | spam | unspam | read | unread | archive */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  action?: string;
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

  @Post('compose')
  @ApiOperation({ summary: 'Envia e-mail novo (compose livre)' })
  compose(
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Body() dto: EmailComposeDto,
  ) {
    return this.email.compose(orgId, access, dto);
  }

  @Post('archive')
  @ApiOperation({ summary: 'Arquiva thread Gmail (remove INBOX)' })
  archive(
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Body() dto: EmailArchiveDto,
  ) {
    return this.email.archive(orgId, access, dto);
  }

  @Get('attachments')
  @ApiOperation({ summary: 'Baixa anexo Gmail (binary)' })
  async attachment(
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Query('channelId') channelId: string,
    @Query('messageId') messageId: string,
    @Query('attachmentId') attachmentId: string,
    @Query('filename') filename: string | undefined,
    @Query('mimeType') mimeType: string | undefined,
    @Res() res: Response,
  ) {
    const { buffer } = await this.email.getAttachment(orgId, access, {
      channelId,
      messageId,
      attachmentId,
    });
    const name = (filename || 'anexo').replace(/[\r\n"]/g, '_');
    res.setHeader(
      'Content-Type',
      mimeType || 'application/octet-stream',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${name}"`,
    );
    res.setHeader('Content-Length', String(buffer.length));
    res.send(buffer);
  }

  @Post('modify')
  @ApiOperation({
    summary:
      'Altera labels do thread (star/spam/lido/arquivar/custom). Atalho via action=.',
  })
  modify(
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Body() dto: EmailModifyDto,
  ) {
    const action = (dto.action || '').toLowerCase();
    let add = dto.addLabelIds || [];
    let remove = dto.removeLabelIds || [];
    switch (action) {
      case 'star':
        add = [...add, 'STARRED'];
        break;
      case 'unstar':
        remove = [...remove, 'STARRED'];
        break;
      case 'spam':
        add = [...add, 'SPAM'];
        remove = [...remove, 'INBOX'];
        break;
      case 'unspam':
        remove = [...remove, 'SPAM'];
        add = [...add, 'INBOX'];
        break;
      case 'read':
        remove = [...remove, 'UNREAD'];
        break;
      case 'unread':
        add = [...add, 'UNREAD'];
        break;
      case 'archive':
        remove = [...remove, 'INBOX'];
        break;
      case 'important':
        add = [...add, 'IMPORTANT'];
        break;
      case 'unimportant':
        remove = [...remove, 'IMPORTANT'];
        break;
      default:
        break;
    }
    return this.email.modifyLabels(orgId, access, {
      channelId: dto.channelId,
      threadId: dto.threadId,
      addLabelIds: add,
      removeLabelIds: remove,
    });
  }
}
