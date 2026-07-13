import { Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CurrentChannelAccess, CurrentOrg } from '../../../common/decorators';
import { ApiKeyAuthGuard } from '../../../common/guards';
import type { ChannelAccess } from '../../iam/channel-access/channel-access.service';
import { HermesWhatsappFeedQueryDto } from '../dto/hermes-whatsapp-feed-query.dto';
import { HermesWhatsappFeedService } from '../services/hermes-whatsapp-feed.service';
import { HermesWhatsappMcpService } from '../services/hermes-whatsapp-mcp.service';
import type { Request, Response } from 'express';

@ApiTags('Public API · Hermes')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard)
@Controller('public/hermes')
export class PublicHermesController {
  constructor(
    private readonly feed: HermesWhatsappFeedService,
    private readonly mcpService: HermesWhatsappMcpService,
  ) {}

  @Get('whatsapp-feed')
  @ApiOperation({ summary: 'Incremental WhatsApp feed for Hermes' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 100 })
  getWhatsappFeed(
    @CurrentOrg('id') organizationId: string,
    @CurrentChannelAccess() channelAccess: ChannelAccess,
    @Query() query: HermesWhatsappFeedQueryDto,
  ) {
    return this.feed.getFeed(organizationId, channelAccess, query);
  }

  @Post('mcp')
  @ApiOperation({ summary: 'Stateless Streamable HTTP MCP endpoint for Hermes' })
  async mcp(
    @CurrentOrg('id') organizationId: string,
    @CurrentChannelAccess() channelAccess: ChannelAccess,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.mcpService.handleHttpRequest(
      request,
      response,
      organizationId,
      channelAccess,
    );
  }

  @Get('mcp')
  @ApiOperation({ summary: 'Rejects standalone MCP streams in stateless mode' })
  mcpGet(@Res() response: Response): void {
    this.mcpService.writeMcpError(response, 405, -32000, 'Method not allowed');
  }
}
