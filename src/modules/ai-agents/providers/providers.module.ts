import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../../database/prisma.module';
import { LlmModule } from '../llm/llm.module';
import { AiLlmRouterService } from './ai-llm-router.service';
import { GeminiLlmAdapter } from './gemini-llm.adapter';
import { OpenAiLlmAdapter } from './openai-llm.adapter';
import { ProviderResolverService } from './provider-resolver.service';

/**
 * Módulo agregador dos providers de IA (S18/W2).
 *
 * Exporta `ProviderResolverService` (resolve credentials per-org-capability)
 * e `AiLlmRouterService` (entry-point unificado de LLM completion que
 * roteia pra adapter correto baseado no provider escolhido pela org).
 *
 * `OrgCredentialsModule` é @Global, então não precisamos importar explícito.
 */
@Module({
  imports: [ConfigModule, PrismaModule, LlmModule],
  providers: [
    ProviderResolverService,
    OpenAiLlmAdapter,
    GeminiLlmAdapter,
    AiLlmRouterService,
  ],
  exports: [
    ProviderResolverService,
    AiLlmRouterService,
    OpenAiLlmAdapter,
    GeminiLlmAdapter,
  ],
})
export class AiProvidersModule {}
