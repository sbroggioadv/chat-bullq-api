import { HttpException, HttpStatus } from '@nestjs/common';

export const CLICKUP_CODES = {
  NOT_CONFIGURED: 'CLICKUP_NOT_CONFIGURED',
  ORG_FORBIDDEN: 'CLICKUP_ORG_FORBIDDEN',
  CONVERSATION_NOT_FOUND: 'CLICKUP_CONVERSATION_NOT_FOUND',
  TASK_NOT_BOUND: 'CLICKUP_TASK_NOT_BOUND',
  ACTIVITIES_UNAVAILABLE: 'CLICKUP_ACTIVITIES_UNAVAILABLE',
  INVALID_VALUE: 'CLICKUP_INVALID_VALUE',
  UPSTREAM: 'CLICKUP_UPSTREAM',
  TIMEOUT: 'CLICKUP_TIMEOUT',
} as const;

export function clickupHttpError(
  status: number,
  code: string,
  message: string,
): never {
  throw new HttpException({ message, code }, status);
}

export function notConfigured(reason = 'ClickUp não configurado'): never {
  clickupHttpError(HttpStatus.SERVICE_UNAVAILABLE, CLICKUP_CODES.NOT_CONFIGURED, reason);
}

export function orgForbidden(): never {
  clickupHttpError(
    HttpStatus.FORBIDDEN,
    CLICKUP_CODES.ORG_FORBIDDEN,
    'organização não autorizada para o ClickUp do escritório',
  );
}

export function conversationNotFound(): never {
  clickupHttpError(
    HttpStatus.NOT_FOUND,
    CLICKUP_CODES.CONVERSATION_NOT_FOUND,
    'conversa não encontrada',
  );
}

export function taskNotBound(message = 'task não vinculada a esta conversa'): never {
  clickupHttpError(HttpStatus.NOT_FOUND, CLICKUP_CODES.TASK_NOT_BOUND, message);
}

export function activitiesUnavailable(message: string): never {
  clickupHttpError(HttpStatus.PRECONDITION_FAILED, CLICKUP_CODES.ACTIVITIES_UNAVAILABLE, message);
}

export function invalidValue(message: string): never {
  clickupHttpError(HttpStatus.UNPROCESSABLE_ENTITY, CLICKUP_CODES.INVALID_VALUE, message);
}

export function mapUpstream(err: unknown): never {
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : 'ClickUp indisponível';
  if (status === 504 || (err as { name?: string })?.name === 'AbortError') {
    clickupHttpError(HttpStatus.GATEWAY_TIMEOUT, CLICKUP_CODES.TIMEOUT, 'ClickUp: tempo limite excedido');
  }
  if (status === 412) {
    activitiesUnavailable(message);
  }
  if (status === 404 || status === 403) {
    taskNotBound(message);
  }
  clickupHttpError(HttpStatus.BAD_GATEWAY, CLICKUP_CODES.UPSTREAM, 'ClickUp indisponível');
}

const PERMANENT_REMOTE = /inacessível|não pertence|incompatível|WhatsApp|CLICKUP_TEAM|perfil/i;

export function isPermanentRemoteFailure(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 401 || status === 403) return true;
  if (status === 504 || (err as { name?: string })?.name === 'AbortError') return false;
  if (typeof status === 'number' && status >= 500) return false;
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (PERMANENT_REMOTE.test(message)) return true;
  if (err instanceof HttpException && err.getStatus() === HttpStatus.SERVICE_UNAVAILABLE) return true;
  return typeof status === 'number' && status >= 400 && status < 500;
}
