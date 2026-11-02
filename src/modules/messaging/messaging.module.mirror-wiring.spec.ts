// Fronteira Redis: o IdempotencyService (provider real do módulo) abre um
// cliente ioredis no construtor. Aqui o cliente é falso — nenhuma conexão.
jest.mock('ioredis', () => {
  class FakeRedis {
    quit = jest.fn(async () => 'OK');
    disconnect = jest.fn();
    on = jest.fn();
  }
  return { __esModule: true, default: FakeRedis, Redis: FakeRedis };
});

import * as os from 'os';
import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { MessagingModule } from './messaging.module';
import { InboundMediaMirrorService } from './messages/inbound-media-mirror.service';
import { InboundMessageProcessor } from './pipeline/inbound-message.processor';
import { HistoryImportService } from './pipeline/history-import.service';

/**
 * SPEC-017 rodada 2, achado 9 — prova a ligação Nest do espelhamento.
 *
 * Os providers vêm do PRÓPRIO MessagingModule (metadata do decorator), não de
 * uma lista copiada: se alguém tirar InboundMediaMirrorService do módulo, este
 * teste falha. Tudo que o MessagingModule recebe de fora (Prisma, filas
 * BullMQ, storage, gateway, serviços de outros módulos) vira mock, e o cliente
 * Redis é falso; os providers do módulo são as classes reais, instanciadas
 * pelo injetor do Nest.
 */

const ownProviders: Provider[] = Reflect.getMetadata('providers', MessagingModule) ?? [];
const ownClasses = new Set<unknown>(ownProviders);

/** Mock de fronteira: qualquer método vira jest.fn(); não é "thenable". */
function boundaryMock(): Record<string | symbol, unknown> {
  const cache = new Map<string | symbol, unknown>();
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined;
        if (!cache.has(prop)) cache.set(prop, jest.fn());
        return cache.get(prop);
      },
    },
  );
}

describe('MessagingModule — ligação do InboundMediaMirrorService', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    moduleRef = await Test.createTestingModule({
      providers: [
        ...ownProviders,
        // UploadsService cria a pasta de uploads no construtor: aponta para o tmp do SO.
        { provide: ConfigService, useValue: { get: (k: string) => (k === 'UPLOADS_DIR' ? os.tmpdir() : undefined) } },
      ],
    })
      .useMocker((token) => {
        // Provider do próprio módulo nunca é mockado: se faltar, a falha aparece.
        if (ownClasses.has(token) || token === InboundMediaMirrorService) return undefined;
        return boundaryMock();
      })
      .compile();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await moduleRef?.close();
  });

  it('o módulo declara o serviço, o downloader e o worker da fila', () => {
    const names = ownProviders.map((p: any) => p?.name);

    expect(names).toEqual(
      expect.arrayContaining(['InboundMediaMirrorService', 'MetaMediaDownloader', 'InboundMediaMirrorProcessor']),
    );
  });

  it('InboundMessageProcessor e HistoryImportService recebem a MESMA instância real do serviço', () => {
    const mirror = moduleRef.get(InboundMediaMirrorService);
    const processor = moduleRef.get(InboundMessageProcessor);
    const importer = moduleRef.get(HistoryImportService);

    expect(mirror).toBeInstanceOf(InboundMediaMirrorService);
    expect((processor as any).mediaMirror).toBe(mirror);
    expect((importer as any).mediaMirror).toBe(mirror);
  });
});
