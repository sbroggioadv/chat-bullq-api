import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg } from '../../common/decorators';
import { ClickUpInboxService } from './clickup-inbox.service';
import { BindWorkbenchDto, CreateWorkbenchTaskDto } from './dto/clickup-inbox.dto';

@ApiTags('ClickUp inbox workbench')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('clickup-inbox/conversations/:conversationId/workbench')
export class ClickUpInboxWorkbenchController {
  constructor(private readonly service: ClickUpInboxService) {}

  @Get()
  @ApiOperation({ summary: 'Resolve o workbench ClickUp da conversa' })
  resolve(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.service.resolveWorkbench(orgId, conversationId);
  }

  @Get('catalog')
  @ApiOperation({ summary: 'Catálogo de atalhos (W0). Árvore live entra em W1.' })
  catalog(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.service.catalogWorkbench(orgId, conversationId);
  }

  @Get('tasks/search')
  @ApiOperation({ summary: 'Busca tasks ClickUp no catálogo de atalhos' })
  search(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
    @Query('q') q: string,
  ) {
    return this.service.searchWorkbenchTasks(orgId, conversationId, q);
  }

  @Post('bind')
  @ApiOperation({ summary: 'Vincula a conversa a uma task ClickUp existente' })
  bind(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() dto: BindWorkbenchDto,
  ) {
    return this.service.bindWorkbenchTask(orgId, conversationId, idempotencyKey, dto);
  }

  @Post('tasks')
  @ApiOperation({ summary: 'Cria uma task ClickUp numa lista de atalho e ancora na conversa' })
  create(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() dto: CreateWorkbenchTaskDto,
  ) {
    return this.service.createWorkbenchTask(orgId, conversationId, idempotencyKey, dto);
  }

  @Post('incorporations')
  @ApiOperation({ summary: 'W3 stub — incorporar fica na próxima wave' })
  incorporate() {
    return this.service.incorporateWorkbench();
  }
}
