import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg } from '../../common/decorators';
import { ClickUpInboxService } from './clickup-inbox.service';
import { BindWorkbenchDto, CreateWorkbenchTaskDto, IncorporateWorkbenchDto } from './dto/clickup-inbox.dto';

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
  @ApiOperation({ summary: 'Catálogo live space → folder → list (atalhos se catalogSpaces vazio)' })
  catalog(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.service.catalogWorkbench(orgId, conversationId);
  }

  @Get('tasks/search')
  @ApiOperation({ summary: 'Busca tasks ClickUp no catálogo (atalhos, ou um space allowlisted)' })
  search(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
    @Query('q') q: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.service.searchWorkbenchTasks(orgId, conversationId, q, spaceId);
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
  @ApiOperation({ summary: 'Cria uma task ClickUp numa lista autorizada (atalhos ∪ catálogo live)' })
  create(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() dto: CreateWorkbenchTaskDto,
  ) {
    return this.service.createWorkbenchTask(orgId, conversationId, idempotencyKey, dto);
  }

  @Post('incorporations')
  @ApiOperation({ summary: 'Incorpora um comentário XOR um anexo na task vinculada' })
  incorporate(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() dto: IncorporateWorkbenchDto,
  ) {
    return this.service.incorporateWorkbench(orgId, conversationId, idempotencyKey, dto);
  }
}
