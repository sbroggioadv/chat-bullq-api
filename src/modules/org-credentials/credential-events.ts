import { Injectable } from '@nestjs/common';
import { AiProvider } from '@prisma/client';

export interface CredentialChangedPayload {
  organizationId: string;
  provider: AiProvider;
}

type Listener = (payload: CredentialChangedPayload) => void;

/**
 * Pub-sub minimal em-memória pra notificar invalidação de cache de
 * credentials.
 *
 * Single-process só. Multi-instance precisa migrar pra Redis pubsub
 * ou trocar pra @nestjs/event-emitter (não instalado hoje pra evitar
 * dependência nova).
 *
 * Por que custom em vez de RxJS Subject? Subject seria igualmente válido —
 * preferi API explícita com tipagem do payload e zero deps adicionais.
 */
@Injectable()
export class CredentialEventsBus {
  private readonly listeners = new Set<Listener>();

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(payload: CredentialChangedPayload): void {
    for (const listener of this.listeners) {
      // Síncrono: handlers devem ser leves (limpar cache, etc).
      try {
        listener(payload);
      } catch {
        // Listener mal-comportado não derruba outros listeners.
      }
    }
  }
}
