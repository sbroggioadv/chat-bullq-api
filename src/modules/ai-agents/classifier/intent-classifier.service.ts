import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { LlmMessage } from '../llm/llm.types';
import {
  CLASSIFIER_SYSTEM_PROMPT,
  buildClassifierUserPrompt,
  buildDynamicClassifierSystemPrompt,
} from './classifier.prompt';
import {
  ClassificationResult,
  ClassifierConfig,
  ClassifierMessage,
  IntentType,
} from './intent.types';
import { IntentRouterService } from './intent-router.service';

/**
 * Camada leve de pré-roteamento que roda antes do orchestrator (Augusto).
 *
 * Fluxo:
 *  1. Pega a mensagem (e até 3 do histórico) e manda pro Haiku via LlmService
 *     pedindo um JSON estruturado.
 *  2. Faz parsing tolerante — se o modelo voltar markdown ou texto extra,
 *     ainda extrai o JSON de dentro.
 *  3. Decide se o orchestrator pode ser pulado: precisa de confidence acima
 *     do threshold E intent direcionável (não AMBIGUOUS/SPAM/ESCALATE/SMALL).
 *  4. Estima custo da chamada — se o LlmService já trouxe `usage.costUsd`,
 *     usa direto; caso contrário, calcula com base nos tokens (Haiku tem
 *     preço público estável).
 *
 * Erros NÃO derrubam a request: se o classifier falhar, devolve um result
 * com intent=AMBIGUOUS pra forçar fallback no orchestrator.
 */
@Injectable()
export class IntentClassifierService {
  private readonly logger = new Logger(IntentClassifierService.name);
  private readonly DEFAULT_MODEL = 'claude-haiku-4-5';
  private readonly DEFAULT_THRESHOLD = 0.85;

  // Preço público da Anthropic pra Haiku 3.5 (USD por token).
  // Usado só como fallback quando o provider não retorna `cost`.
  private readonly HAIKU_INPUT_USD_PER_TOKEN = 1.0 / 1_000_000;
  private readonly HAIKU_OUTPUT_USD_PER_TOKEN = 5.0 / 1_000_000;

  constructor(
    private readonly llm: LlmService,
    private readonly intentRouter: IntentRouterService,
  ) {}

  async classify(
    message: string,
    recentMessages?: ClassifierMessage[],
    config?: Partial<ClassifierConfig>,
  ): Promise<ClassificationResult> {
    const t0 = Date.now();
    const model = config?.model ?? this.DEFAULT_MODEL;
    const threshold = config?.threshold ?? this.DEFAULT_THRESHOLD;

    // S23 — Modo dinâmico: com catálogo presente, o prompt é montado a
    // partir dos workers do canal em vez das personas hardcoded.
    const agentCatalog =
      config?.agentCatalog && config.agentCatalog.length > 0
        ? config.agentCatalog
        : null;
    const systemPrompt = agentCatalog
      ? buildDynamicClassifierSystemPrompt(agentCatalog)
      : CLASSIFIER_SYSTEM_PROMPT;

    const messages: LlmMessage[] = [
      {
        role: 'system',
        content: [{ type: 'text', text: systemPrompt, cache: true }],
      },
      {
        role: 'user',
        content: buildClassifierUserPrompt(message, recentMessages),
      },
    ];

    try {
      const resp = await this.llm.complete({
        modelId: model,
        messages,
        temperature: 0,
        maxTokens: 200,
      });

      const raw =
        typeof resp.message.content === 'string'
          ? resp.message.content
          : resp.message.content
              .filter((p) => p.type === 'text')
              .map((p) => p.text)
              .join('');

      const parsed = this.parseClassifierJson(raw);
      const intent = this.normalizeIntent(parsed?.intent);
      const confidence = this.normalizeConfidence(parsed?.confidence);
      const reasoning =
        typeof parsed?.reasoning === 'string'
          ? parsed.reasoning.slice(0, 300)
          : '';
      const suggestedAgentRaw =
        typeof parsed?.suggestedAgent === 'string' && parsed.suggestedAgent
          ? parsed.suggestedAgent
          : null;

      let suggestedAgent: string | null;
      let skippedOrchestrator: boolean;
      if (agentCatalog) {
        // S23 — Modo dinâmico: só aceita nome que exista no catálogo do
        // canal. "NONE", nome inventado ou de agente de outra marca/canal
        // → sem skip, fallback no orchestrator. O nome devolvido é o
        // canônico do banco (match case-insensitive, resposta exata).
        const normalized = suggestedAgentRaw?.trim();
        const matched =
          normalized && normalized.toUpperCase() !== 'NONE'
            ? agentCatalog.find(
                (a) => a.name.toLowerCase() === normalized.toLowerCase(),
              )
            : undefined;
        suggestedAgent = matched?.name ?? null;
        skippedOrchestrator =
          intent === IntentType.AGENT_MATCH &&
          !!matched &&
          confidence >= threshold;
      } else {
        // Modo estático (legado) — decisão de skip leva em conta tanto o
        // threshold quanto a categoria do intent — AMBIGUOUS/SPAM/ESCALATE/
        // SMALL_TALK SEMPRE caem no orchestrator, mesmo com confidence alta.
        // suggestedAgent vem SÓ do mapa validado intent→agente — o nome
        // bruto do LLM nunca propaga (nome inventado viraria lookup por
        // nome no router).
        const route = this.intentRouter.routeIntent(intent);
        skippedOrchestrator =
          route.shouldSkipOrchestrator && confidence >= threshold;
        suggestedAgent = route.agentName ?? null;
      }

      // Custo: prefere o `cost` do provider quando disponível, senão
      // estima com a tabela de preço do Haiku.
      const costUsd =
        resp.usage.costUsd > 0
          ? resp.usage.costUsd
          : resp.usage.inputTokens * this.HAIKU_INPUT_USD_PER_TOKEN +
            resp.usage.outputTokens * this.HAIKU_OUTPUT_USD_PER_TOKEN;

      const durationMs = Date.now() - t0;

      const result: ClassificationResult = {
        intent,
        confidence,
        reasoning,
        suggestedAgent,
        skippedOrchestrator,
        modelUsed: resp.rawModelId ?? model,
        costUsd,
        durationMs,
      };

      this.logger.log(
        JSON.stringify({
          msg: 'intent_classified',
          intent: result.intent,
          confidence: result.confidence,
          skipped: result.skippedOrchestrator,
          costUsd: Number(result.costUsd.toFixed(6)),
          durationMs: result.durationMs,
          model: result.modelUsed,
        }),
      );

      return result;
    } catch (err: any) {
      // Falha no classifier não pode quebrar a request — devolve AMBIGUOUS
      // pra forçar o fallback no orchestrator e loga o motivo.
      const durationMs = Date.now() - t0;
      this.logger.warn(
        JSON.stringify({
          msg: 'intent_classifier_failed',
          error: err?.message ?? String(err),
          durationMs,
        }),
      );
      return {
        intent: IntentType.AMBIGUOUS,
        confidence: 0,
        reasoning: `classifier failed: ${err?.message ?? 'unknown'}`,
        suggestedAgent: null,
        skippedOrchestrator: false,
        modelUsed: model,
        costUsd: 0,
        durationMs,
      };
    }
  }

  /**
   * Parse tolerante: tenta JSON.parse direto, senão extrai o primeiro
   * objeto JSON de dentro do texto (modelos às vezes embrulham em ```json).
   */
  private parseClassifierJson(raw: string): Record<string, unknown> | null {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();

    // Caminho feliz.
    try {
      return JSON.parse(trimmed);
    } catch {
      // segue pro fallback
    }

    // Tira fences de markdown (```json ... ``` ou ``` ... ```).
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced && fenced[1]) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        // segue pro último fallback
      }
    }

    // Último recurso: pega o primeiro {...} balanceado.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const slice = trimmed.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch {
        return null;
      }
    }

    return null;
  }

  private normalizeIntent(raw: unknown): IntentType {
    if (typeof raw !== 'string') return IntentType.AMBIGUOUS;
    const upper = raw.trim().toUpperCase().replace(/\s+/g, '_');
    if ((Object.values(IntentType) as string[]).includes(upper)) {
      return upper as IntentType;
    }
    return IntentType.AMBIGUOUS;
  }

  private normalizeConfidence(raw: unknown): number {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 1) return n > 1.5 ? n / 100 : 1; // tolera "85" (=0.85) ou "0.85"
    return n;
  }
}
