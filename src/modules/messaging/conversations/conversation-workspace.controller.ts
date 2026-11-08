import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../../common/guards';
import { CurrentChannelAccess, CurrentOrg, CurrentUser } from '../../../common/decorators';
import type { ChannelAccess } from '../../iam/channel-access/channel-access.service';
import { ConversationWorkspaceService } from './conversation-workspace.service';

@ApiTags('Conversation workspace')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('conversations')
export class ConversationWorkspaceController {
  constructor(private readonly service: ConversationWorkspaceService) {}

  @Patch(':id/mute')
  mute(@Param('id') id: string, @CurrentOrg('id') org: string, @CurrentUser('id') actor: string, @CurrentChannelAccess() access: ChannelAccess, @Body() body: { mode?: unknown }) {
    return this.service.mute(id, org, actor, access, body?.mode);
  }

  @Get(':id/notes')
  notes(@Param('id') id: string, @CurrentOrg('id') org: string, @CurrentChannelAccess() access: ChannelAccess) {
    return this.service.notes(id, org, access);
  }

  @Post(':id/notes')
  createNote(@Param('id') id: string, @CurrentOrg('id') org: string, @CurrentUser('id') actor: string, @CurrentChannelAccess() access: ChannelAccess, @Body() body: { content?: unknown }) {
    return this.service.createNote(id, org, actor, access, body?.content);
  }

  @Patch(':id/notes/:noteId')
  updateNote(@Param('id') id: string, @CurrentOrg('id') org: string, @CurrentUser('id') actor: string, @CurrentChannelAccess() access: ChannelAccess, @Param('noteId') noteId: string, @Body() body: { content?: unknown }) {
    return this.service.updateNote(id, org, actor, access, noteId, body?.content);
  }

  @Delete(':id/notes/:noteId')
  deleteNote(@Param('id') id: string, @CurrentOrg('id') org: string, @CurrentUser('id') actor: string, @CurrentChannelAccess() access: ChannelAccess, @Param('noteId') noteId: string) {
    return this.service.deleteNote(id, org, actor, access, noteId);
  }

  @Get(':id/send-channels')
  sendChannels(@Param('id') id: string, @CurrentOrg('id') org: string, @CurrentChannelAccess() access: ChannelAccess) {
    return this.service.sendChannels(id, org, access);
  }

  @Post(':id/send-channels/:channelId/open')
  openChannel(@Param('id') id: string, @CurrentOrg('id') org: string, @CurrentUser('id') actor: string, @CurrentChannelAccess() access: ChannelAccess, @Param('channelId') channelId: string) {
    return this.service.openChannel(id, org, actor, access, channelId);
  }
}
