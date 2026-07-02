import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../../database/prisma.module';
import { LlmModule } from '../llm/llm.module';
import { AiLlmRouterService } from './ai-llm-router.service';
import { GeminiLlmAdapter } from './gemini-llm.adapter';
import { KimiLlmAdapter } from './kimi-llm.adapter';
import { OpenAiCompatibleAdapter } from './openai-compatible.adapter';
import { OpenAiLlmAdapter } from './openai-llm.adapter';
import { ProviderResolverService } from './provider-resolver.service';
import { ZaiLlmAdapter } from './zai-llm.adapter';

/**
 * Módulo agregador dos providers de IA (S18/W2).
 *
 * Exporta `ProviderResolverService` (resolve credentials + baseUrl per-org-
 * capability) e `AiLlmRouterService` (entry-point unificado de LLM completion
 * que roteia pra adapter correto baseado no provider escolhido pela org).
 *
 * Providers OpenAI-compatible (OpenAI, Kimi/Moonshot, z.ai/Zhipu) compartilham
 * `OpenAiCompatibleAdapter` — os adapters concretos são cascas finas que só
 * carregam base URL default, modelo fallback e tabela de custo.
 *
 * `OrgCredentialsModule` é @Global, então não precisamos importar explícito.
 */
@Module({
  imports: [ConfigModule, PrismaModule, LlmModule],
  providers: [
    ProviderResolverService,
    OpenAiCompatibleAdapter,
    OpenAiLlmAdapter,
    GeminiLlmAdapter,
    KimiLlmAdapter,
    ZaiLlmAdapter,
    AiLlmRouterService,
  ],
  exports: [
    ProviderResolverService,
    AiLlmRouterService,
    OpenAiCompatibleAdapter,
    OpenAiLlmAdapter,
    GeminiLlmAdapter,
    KimiLlmAdapter,
    ZaiLlmAdapter,
  ],
})
export class AiProvidersModule {}
