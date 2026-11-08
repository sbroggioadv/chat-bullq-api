import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, CurrentChannelAccess } from '../../common/decorators';
import { ClickUpInboxService } from './clickup-inbox.service';
import { ChannelAccessService, type ChannelAccess } from '../iam/channel-access/channel-access.service';
import { BindGroupTaskDto, CreateGroupTaskDto, IncorporateWorkbenchDto } from './dto/clickup-inbox.dto';

@ApiTags('ClickUp inbox grupo')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('clickup-inbox/conversations/:conversationId/group')
export class ClickUpInboxGroupController {
  constructor(private readonly service: ClickUpInboxService, private readonly channelAccess: ChannelAccessService) {}

  @Get()
  @ApiOperation({ summary: 'Resolve o estado ClickUp do grupo via dossiê' })
  resolve(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.service.resolveGroup(orgId, conversationId);
  }

  @Get('tasks/search')
  @ApiOperation({ summary: 'Busca tasks ClickUp no catálogo de projetos para seleção explícita' })
  search(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
    @Query('q') q: string,
  ) {
    return this.service.searchGroupTasks(orgId, conversationId, q);
  }

  @Post('bind')
  @ApiOperation({ summary: 'Alias — vincula a conversa a uma task ClickUp existente' })
  bind(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() dto: BindGroupTaskDto,
  ) {
    return this.service.bindGroupTask(orgId, conversationId, dto.taskRef, idempotencyKey);
  }

  @Post('tasks')
  @ApiOperation({ summary: 'Cria uma task ClickUp no catálogo de projetos e ancora no dossiê' })
  create(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() dto: CreateGroupTaskDto,
  ) {
    return this.service.createGroupTask(orgId, conversationId, idempotencyKey, dto);
  }

  @Post('incorporations')
  @ApiOperation({ summary: 'Alias — incorpora um comentário XOR um anexo na task vinculada' })
  async incorporate(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() dto: IncorporateWorkbenchDto,
    @CurrentChannelAccess() access: ChannelAccess,
  ) {
    await this.channelAccess.assertConversationAccess(access, conversationId, orgId);
    return this.service.incorporateGroup(orgId, conversationId, idempotencyKey, dto);
  }
}
