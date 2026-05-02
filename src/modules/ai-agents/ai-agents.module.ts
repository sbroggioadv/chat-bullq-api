import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../database/prisma.module';
import { LlmModule } from './llm/llm.module';
import { ToolsModule } from './tools/tools.module';
import { PromptBuilderService } from './runner/prompt-builder.service';
import { AiAgentRunnerService } from './runner/agent-runner.service';
import { AgentRouterService } from './router/agent-router.service';
import { AgentsService } from './agents/agents.service';
import { AgentsController } from './agents/agents.controller';

@Module({
  imports: [ConfigModule, PrismaModule, LlmModule, ToolsModule],
  controllers: [AgentsController],
  providers: [
    PromptBuilderService,
    AiAgentRunnerService,
    AgentRouterService,
    AgentsService,
  ],
  exports: [AiAgentRunnerService, AgentRouterService],
})
export class AiAgentsModule {}
