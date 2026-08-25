import { ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { GlobalExceptionFilter } from './http-exception.filter';

function hostWith(json: jest.Mock, url = '/clickup-inbox/conversations/conv-a'): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => ({
        status: () => ({ json }),
      }),
      getRequest: () => ({ method: 'GET', url }),
    }),
  } as unknown as ArgumentsHost;
}

describe('GlobalExceptionFilter (F-05)', () => {
  const filter = new GlobalExceptionFilter();

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('preserva code seguro no envelope', () => {
    const json = jest.fn();
    filter.catch(
      new HttpException(
        { message: 'deve existir exatamente uma lista principal', code: 'CLICKUP_NOT_CONFIGURED' },
        HttpStatus.SERVICE_UNAVAILABLE,
      ),
      hostWith(json),
    );
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 503,
        message: 'deve existir exatamente uma lista principal',
        code: 'CLICKUP_NOT_CONFIGURED',
      }),
    );
  });

  it.each([
    ['CLICKUP_NOT_CONFIGURED', 503, 'perfil inválido'],
    ['CLICKUP_NOT_CONFIGURED', 503, 'ClickUp recusou a requisição (HTTP 401)'],
    ['CLICKUP_UPSTREAM', 502, 'ClickUp indisponível'],
    ['CLICKUP_TIMEOUT', 504, 'ClickUp: tempo limite excedido'],
  ])('envelope %s/%s', (code, status, message) => {
    const json = jest.fn();
    filter.catch(new HttpException({ message, code }, status), hostWith(json));
    expect(json.mock.calls[0][0]).toEqual(expect.objectContaining({ statusCode: status, message, code }));
  });

  it('409 preserva match no envelope', () => {
    const json = jest.fn();
    filter.catch(
      new HttpException(
        {
          message: 'já existe card para este telefone',
          code: 'CLICKUP_MATCH_CONFLICT',
          match: { status: 'unico', taskId: 'task-1' },
        },
        HttpStatus.CONFLICT,
      ),
      hostWith(json),
    );
    expect(json.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        statusCode: 409,
        code: 'CLICKUP_MATCH_CONFLICT',
        match: { status: 'unico', taskId: 'task-1' },
      }),
    );
  });

  it('409 de troca de âncora preserva card no envelope', () => {
    const json = jest.fn();
    filter.catch(
      new HttpException(
        {
          message: 'esta conversa já tem uma task vinculada',
          code: 'CLICKUP_ANCHOR_SWITCH_REQUIRED',
          card: { taskId: 'task-consultivo', nome: 'Consultivo', token: 'secret' },
        },
        HttpStatus.CONFLICT,
      ),
      hostWith(json),
    );
    expect(json.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        statusCode: 409,
        code: 'CLICKUP_ANCHOR_SWITCH_REQUIRED',
        card: expect.objectContaining({ taskId: 'task-consultivo' }),
      }),
    );
    expect(json.mock.calls[0][0].card.token).toBeUndefined();
  });

  it('não propaga code inseguro', () => {
    const json = jest.fn();
    filter.catch(
      new HttpException({ message: 'x', code: '<script>' }, 400),
      hostWith(json),
    );
    expect(json.mock.calls[0][0].code).toBeUndefined();
  });
});
