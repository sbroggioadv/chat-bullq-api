import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { AgentsService } from './agents.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { AssignAgentChannelDto } from './dto/assign-channel.dto';
import { CurrentOrg, Roles } from '../../../common/decorators';
import {
  JwtAuthGuard,
  OrgGuard,
  RolesGuard,
} from '../../../common/guards';

@ApiTags('AI Agents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('ai-agents')
export class AgentsController {
  constructor(private readonly service: AgentsService) {}

  @Post()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Create a new AI agent' })
  create(@CurrentOrg('id') orgId: string, @Body() dto: CreateAgentDto) {
    return this.service.create(orgId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List AI agents for the organization' })
  list(@CurrentOrg('id') orgId: string) {
    return this.service.list(orgId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single AI agent' })
  findOne(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.findOne(orgId, id);
  }

  @Patch(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Update an AI agent' })
  update(
    @CurrentOrg('id') orgId: string,
    @Param('id') id: string,
    @Body() dto: UpdateAgentDto,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Soft-delete an AI agent' })
  remove(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.softDelete(orgId, id);
  }

  @Post(':id/channels')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Assign agent to a channel (or update mode)' })
  assignChannel(
    @CurrentOrg('id') orgId: string,
    @Param('id') id: string,
    @Body() dto: AssignAgentChannelDto,
  ) {
    return this.service.assignChannel(orgId, id, dto);
  }

  @Delete(':id/channels/:channelId')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Detach agent from a channel' })
  unassignChannel(
    @CurrentOrg('id') orgId: string,
    @Param('id') id: string,
    @Param('channelId') channelId: string,
  ) {
    return this.service.unassignChannel(orgId, id, channelId);
  }

  @Get(':id/runs')
  @ApiOperation({ summary: 'List recent runs of this agent (with tool calls)' })
  runs(
    @CurrentOrg('id') orgId: string,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listRuns(
      orgId,
      id,
      limit ? Math.min(parseInt(limit, 10) || 50, 200) : 50,
    );
  }
}
