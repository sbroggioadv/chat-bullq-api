import {
  Controller,
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
import { CurrentUser, CurrentOrg } from '../../../common/decorators';

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
  ) {
    return this.service.send(dto, userId, orgId);
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

  @Get(':id/media')
  @ApiOperation({
    summary:
      'Resolve a playable media URL for an inbound message. Cached after first call.',
  })
  async getMedia(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
  ) {
    return this.mediaResolver.resolve(id, orgId);
  }

  @Post(':id/transcribe')
  @ApiOperation({
    summary:
      'Transcribe an audio message via Whisper. Cached in metadata.transcription.',
  })
  transcribe(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Query('force') force?: string,
  ) {
    return this.transcription.transcribe(id, orgId, {
      force: force === 'true' || force === '1',
    });
  }

  @Get()
  @ApiOperation({ summary: 'List messages of a conversation (paginated)' })
  @ApiQuery({ name: 'conversationId', required: true })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  findByConversation(
    @Query('conversationId') conversationId: string,
    @CurrentOrg('id') orgId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.findByConversation(
      conversationId,
      orgId,
      parseInt(page || '1', 10),
      parseInt(limit || '50', 10),
    );
  }
}
