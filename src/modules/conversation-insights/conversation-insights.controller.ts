import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentChannelAccess, CurrentOrg } from '../../common/decorators';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import type { ChannelAccess } from '../iam/channel-access/channel-access.service';
import { ConversationInsightsService } from './conversation-insights.service';

@ApiTags('Conversation insights')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('conversations/:id')
export class ConversationInsightsController {
  constructor(private readonly service: ConversationInsightsService) {}

  @Get('messages/search')
  search(@Param('id') id: string, @CurrentOrg('id') org: string, @CurrentChannelAccess() access: ChannelAccess, @Query() query: { q?: string; limit?: string; before?: string }) {
    return this.service.search(id, org, access, query);
  }

  @Get('messages/around/:messageId')
  around(@Param('id') id: string, @CurrentOrg('id') org: string, @CurrentChannelAccess() access: ChannelAccess, @Param('messageId') messageId: string, @Query('limit') limit?: string) {
    return this.service.around(id, org, access, messageId, limit);
  }

  @Get('attachments')
  attachments(@Param('id') id: string, @CurrentOrg('id') org: string, @CurrentChannelAccess() access: ChannelAccess, @Query() query: { kind?: string; limit?: string; before?: string }) {
    return this.service.attachments(id, org, access, query);
  }

  @Get('meetings')
  meetings(@Param('id') id: string, @CurrentOrg('id') org: string, @CurrentChannelAccess() access: ChannelAccess) {
    return this.service.meetings(id, org, access);
  }

  @Get('summary')
  summary(@Param('id') id: string, @CurrentOrg('id') org: string, @CurrentChannelAccess() access: ChannelAccess) {
    return this.service.getSummary(id, org, access);
  }

  @Post('summary')
  generate(@Param('id') id: string, @CurrentOrg('id') org: string, @CurrentChannelAccess() access: ChannelAccess, @Body() body: { force?: boolean }) {
    return this.service.generateSummary(id, org, access, body);
  }
}
