import { Module } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';
import { EmailModule } from '../email/email.module';

/**
 * Projetos como dossiê (SPEC-005): independentes do grupo de WhatsApp.
 * Uma conversa 1:1 ou grupo pode ligar-se a um dossiê; o grupo não é o projeto.
 */
@Module({
  imports: [EmailModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
