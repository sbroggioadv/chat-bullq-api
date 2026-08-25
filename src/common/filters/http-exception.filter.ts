import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response, Request } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse =
      exception instanceof HttpException
        ? exception.getResponse()
        : { message: 'Internal server error' };

    const message =
      typeof exceptionResponse === 'string'
        ? exceptionResponse
        : (exceptionResponse as Record<string, unknown>).message || 'Internal server error';

    const rawCode =
      typeof exceptionResponse === 'object' && exceptionResponse
        ? (exceptionResponse as Record<string, unknown>).code
        : undefined;
    const code =
      typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(rawCode)
        ? rawCode
        : undefined;

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} ${status}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    const payload =
      typeof exceptionResponse === 'object' && exceptionResponse && !Array.isArray(exceptionResponse)
        ? (exceptionResponse as Record<string, unknown>)
        : undefined;
    const match = publicObject(payload?.match);
    const card = publicObject(payload?.card);

    response.status(status).json({
      statusCode: status,
      message,
      ...(code ? { code } : {}),
      ...(match ? { match } : {}),
      ...(card ? { card } : {}),
      error:
        exception instanceof HttpException
          ? exception.name
          : 'InternalServerError',
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}

function publicObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { token: _token, ...rest } = value as Record<string, unknown>;
  return rest;
}
