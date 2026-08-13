import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProjectsService } from './projects.service';
import {
  AddContactDto,
  AttachMessageDto,
  CreateProjectDto,
  CreateTaskDto,
  LinkConversationDto,
  ProjectEmailDto,
  UpdateProjectDto,
  UpdateTaskDto,
} from './dto/project.dto';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, CurrentUser } from '../../common/decorators';

@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('projects')
export class ProjectsController {
  constructor(private readonly service: ProjectsService) {}

  @Post()
  @ApiOperation({ summary: 'Cria um dossiê de projeto (não é o grupo de WhatsApp)' })
  create(
    @CurrentOrg('id') orgId: string,
    @Body() dto: CreateProjectDto,
  ) {
    return this.service.create(orgId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Lista dossiês da organização' })
  list(
    @CurrentOrg('id') orgId: string,
    @Query('hoppeId') hoppeId?: string,
    @Query('responsibleUserId') responsibleUserId?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    return this.service.list(orgId, {
      hoppeId,
      responsibleUserId,
      status,
      search,
    });
  }

  @Get('filters')
  @ApiOperation({ summary: 'Valores distintos (status) para os filtros' })
  filters(@CurrentOrg('id') orgId: string) {
    return this.service.filters(orgId);
  }

  @Get('by-conversation/:conversationId')
  @ApiOperation({ summary: 'Dossiê ligado a esta conversa, se existir' })
  getByConversation(
    @Param('conversationId') conversationId: string,
    @CurrentOrg('id') orgId: string,
  ) {
    return this.service.getForConversation(orgId, conversationId);
  }

  @Put('by-conversation/:conversationId')
  @ApiOperation({
    summary: 'Atualiza o dossiê ligado à conversa, ou cria um novo e liga',
  })
  updateByConversation(
    @Param('conversationId') conversationId: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.service.updateForConversation(orgId, conversationId, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalhe do dossiê' })
  getById(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.getById(orgId, id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Atualiza nome, fase, descrição, responsável' })
  update(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Post(':id/conversations')
  @ApiOperation({ summary: 'Liga uma conversa (1:1 ou grupo) ao dossiê' })
  linkConversation(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: LinkConversationDto,
  ) {
    return this.service.linkConversation(orgId, id, dto.conversationId);
  }

  @Post(':id/tasks')
  @ApiOperation({ summary: 'Adiciona uma task ao dossiê' })
  addTask(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: CreateTaskDto,
  ) {
    return this.service.addTask(orgId, id, dto);
  }

  @Patch(':id/tasks/:taskId')
  @ApiOperation({ summary: 'Atualiza título ou done da task' })
  updateTask(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.service.updateTask(orgId, id, taskId, dto);
  }

  @Delete(':id/tasks/:taskId')
  @ApiOperation({ summary: 'Remove a task' })
  removeTask(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @CurrentOrg('id') orgId: string,
  ) {
    return this.service.removeTask(orgId, id, taskId);
  }

  @Post(':id/attachments')
  @ApiOperation({ summary: 'Anexa uma mensagem da conversa ao dossiê' })
  attachMessage(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: AttachMessageDto,
  ) {
    return this.service.attachMessage(orgId, id, dto, userId);
  }

  @Delete(':id/attachments/:attachmentId')
  @ApiOperation({ summary: 'Remove anexo do dossiê' })
  removeAttachment(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentOrg('id') orgId: string,
  ) {
    return this.service.removeAttachment(orgId, id, attachmentId);
  }

  @Post(':id/contacts')
  @ApiOperation({ summary: 'Adiciona envolvido ao dossiê' })
  addContact(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: AddContactDto,
  ) {
    return this.service.addContact(orgId, id, dto);
  }

  @Delete(':id/contacts/:linkId')
  @ApiOperation({ summary: 'Remove envolvido do dossiê' })
  removeContact(
    @Param('id') id: string,
    @Param('linkId') linkId: string,
    @CurrentOrg('id') orgId: string,
  ) {
    return this.service.removeContact(orgId, id, linkId);
  }

  @Post(':id/email')
  @ApiOperation({ summary: 'Envia e-mail pelo Gmail aos envolvidos do dossiê' })
  emailParticipants(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: ProjectEmailDto,
  ) {
    return this.service.emailParticipants(orgId, id, dto);
  }
}
