import {
  Controller,
  Delete,
  Get,
  Post,
  Body,
  Query,
  Param,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiQuery, ApiConsumes } from '@nestjs/swagger';
import { MessagesService } from './messages.service';
import { TranscriptionService } from './transcription.service';
import { UploadsService } from './uploads.service';
import { MediaResolverService } from './media-resolver.service';
import { SendMessageDto } from './dto/send-message.dto';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../../common/guards';
import {
  CurrentUser,
  CurrentOrg,
  CurrentChannelAccess,
} from '../../../common/decorators';
import type { ChannelAccess } from '../../iam/channel-access/channel-access.service';

@ApiTags('Messages')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('messages')
export class MessagesController {
  constructor(
    private readonly service: MessagesService,
    private readonly transcription: TranscriptionService,
    private readonly uploads: UploadsService,
    private readonly mediaResolver: MediaResolverService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Send a message (enqueues for delivery)' })
  send(
    @Body() dto: SendMessageDto,
    @CurrentUser('id') userId: string,
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.send(dto, userId, orgId, access);
  }

  @Post('uploads/audio')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: UploadsService.MAX_AUDIO_BYTES },
    }),
  )
  @ApiOperation({ summary: 'Upload an audio file; returns public URL.' })
  @ApiConsumes('multipart/form-data')
  async uploadAudio(
    @UploadedFile()
    file?: { buffer: Buffer; mimetype: string; originalname?: string },
  ) {
    if (!file) throw new BadRequestException('file is required');
    return this.uploads.saveAudio({
      buffer: file.buffer,
      mimetype: file.mimetype,
      originalname: file.originalname,
    });
  }

  @Post('uploads/image')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: UploadsService.MAX_IMAGE_BYTES },
    }),
  )
  @ApiOperation({
    summary:
      'Upload an image (jpeg/png/gif/webp). Returns public URL ready to attach to an outbound IMAGE message. Max 10MB.',
  })
  @ApiConsumes('multipart/form-data')
  async uploadImage(
    @UploadedFile()
    file?: { buffer: Buffer; mimetype: string; originalname?: string },
  ) {
    if (!file) throw new BadRequestException('file is required');
    return this.uploads.saveImage({
      buffer: file.buffer,
      mimetype: file.mimetype,
      originalname: file.originalname,
    });
  }

  @Post('uploads/file')
  @UseInterceptors(
    FileInterceptor('file', {
      // Cap absoluto no interceptor — saveFile reaplica cap por tipo internamente.
      limits: { fileSize: UploadsService.MAX_FILE_BYTES },
    }),
  )
  @ApiOperation({
    summary:
      'S18/W3-Z: Upload polimórfico (image/audio/video/document). Roteia internamente por MIME + valida magic bytes. ' +
      'Caps por tipo: image 10MB, audio 25MB, document 50MB, video 100MB. ' +
      'Retorna `{ url, mimeType, size, filename, contentTypeBucket }` pra UI mapear no Message.contentType.',
  })
  @ApiConsumes('multipart/form-data')
  async uploadFile(
    @UploadedFile()
    file?: { buffer: Buffer; mimetype: string; originalname?: string },
  ) {
    if (!file) throw new BadRequestException('file is required');
    return this.uploads.saveFile({
      buffer: file.buffer,
      mimetype: file.mimetype,
      originalname: file.originalname,
    });
  }

  @Get(':id/media')
  @ApiOperation({
    summary:
      'Resolve a playable media URL for an inbound message. Cached after first call.',
  })
  async getMedia(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.mediaResolver.resolve(id, orgId, access);
  }

  @Post(':id/transcribe')
  @ApiOperation({
    summary:
      'Transcribe an audio message via Whisper. Cached in metadata.transcription.',
  })
  transcribe(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Query('force') force?: string,
  ) {
    return this.transcription.transcribe(id, orgId, {
      force: force === 'true' || force === '1',
      access,
    });
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      'Deletar mensagem pra todos. Tenta propagar pro provider — Zappfy suporta (some no app do cliente), Meta WA Cloud e Instagram não suportam (some só no Chat BullQ).',
  })
  revoke(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    return this.service.revokeForEveryone(id, orgId, userId, access);
  }

  @Get()
  @ApiOperation({ summary: 'List messages of a conversation (paginated)' })
  @ApiQuery({ name: 'conversationId', required: true })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  findByConversation(
    @Query('conversationId') conversationId: string,
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.findByConversation(
      conversationId,
      orgId,
      parseInt(page || '1', 10),
      parseInt(limit || '50', 10),
      access,
    );
  }
}
