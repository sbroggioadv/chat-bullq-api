import { Body, Controller, Get, Headers, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, CurrentUser } from '../../common/decorators';
import { ClickUpInboxService } from './clickup-inbox.service';
import {
  PatchFieldDto,
  PatchStatusDto,
  PostActivityDto,
  PostCommentDto,
} from './dto/clickup-inbox.dto';

@ApiTags('ClickUp inbox')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('clickup-inbox/conversations/:conversationId')
export class ClickUpInboxController {
  constructor(private readonly service: ClickUpInboxService) {}

  @Get()
  @ApiOperation({ summary: 'Resolve o card ClickUp da conversa' })
  resolve(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.service.resolve(orgId, conversationId);
  }

  @Post('tasks')
  @ApiOperation({ summary: 'Cria o card ClickUp da conversa quando não há correspondência' })
  createTask(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
    @Headers('idempotency-key') idempotencyKey: string,
  ) {
    return this.service.createTask(orgId, conversationId, idempotencyKey);
  }

  @Get('tasks/:taskId')
  @ApiOperation({ summary: 'Detalhe de um candidato que ainda casa com a conversa' })
  getTask(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
    @Param('taskId') taskId: string,
  ) {
    return this.service.getTask(orgId, conversationId, taskId);
  }

  @Patch('tasks/:taskId/status')
  @ApiOperation({ summary: 'Atualiza a etapa do card' })
  patchStatus(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
    @Param('taskId') taskId: string,
    @Body() dto: PatchStatusDto,
  ) {
    return this.service.patchStatus(orgId, conversationId, taskId, dto.status);
  }

  @Patch('tasks/:taskId/fields/:fieldId')
  @ApiOperation({ summary: 'Atualiza um campo genérico do card' })
  patchField(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
    @Param('taskId') taskId: string,
    @Param('fieldId') fieldId: string,
    @Body() dto: PatchFieldDto,
  ) {
    return this.service.patchField(orgId, conversationId, taskId, fieldId, dto.value);
  }

  @Post('tasks/:taskId/comments')
  @ApiOperation({ summary: 'Registra comentário no card (o que / próximo passo)' })
  postComment(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Param('conversationId') conversationId: string,
    @Param('taskId') taskId: string,
    @Body() dto: PostCommentDto,
  ) {
    return this.service.postComment(orgId, conversationId, taskId, userId, dto);
  }

  @Post('tasks/:taskId/activities')
  @ApiOperation({ summary: 'Cria atividade relacionada ao card' })
  postActivity(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
    @Param('taskId') taskId: string,
    @Body() dto: PostActivityDto,
  ) {
    return this.service.postActivity(orgId, conversationId, taskId, dto);
  }

  @Patch('tasks/:taskId/activities/:activityId/complete')
  @ApiOperation({ summary: 'Conclui uma atividade relacionada ao card' })
  completeActivity(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
    @Param('taskId') taskId: string,
    @Param('activityId') activityId: string,
  ) {
    return this.service.completeActivity(orgId, conversationId, taskId, activityId);
  }
}
