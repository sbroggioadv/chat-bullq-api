import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiProvidersModule } from '../providers/providers.module';
import { IntentClassifierService } from './intent-classifier.service';
import { IntentRouterService } from './intent-router.service';

/**
 * Módulo do Intent Classifier.
 *
 * Não acopla com runner/router/orchestrator — fica isolado pra que outros
 * módulos (futura integração na Fase 2 dentro do AgentRouterService) possam
 * importar e usar sem ciclo de dependência.
 */
@Module({
  imports: [ConfigModule, AiProvidersModule],
  providers: [IntentClassifierService, IntentRouterService],
  exports: [IntentClassifierService, IntentRouterService],
})
export class ClassifierModule {}
