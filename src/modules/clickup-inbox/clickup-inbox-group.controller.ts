import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg } from '../../common/decorators';
import { ClickUpInboxService } from './clickup-inbox.service';
import { BindGroupTaskDto, CreateGroupTaskDto } from './dto/clickup-inbox.dto';

@ApiTags('ClickUp inbox grupo')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('clickup-inbox/conversations/:conversationId/group')
export class ClickUpInboxGroupController {
  constructor(private readonly service: ClickUpInboxService) {}

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
  @ApiOperation({ summary: 'Vincula o dossiê da conversa a uma task ClickUp existente' })
  bind(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
    @Body() dto: BindGroupTaskDto,
  ) {
    return this.service.bindGroupTask(orgId, conversationId, dto.taskRef);
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
  @ApiOperation({ summary: 'W3 stub — incorporar fica na próxima wave' })
  incorporate() {
    return this.service.incorporateGroup();
  }
}
