import { ConflictException } from '@nestjs/common';
import { AiCapability, AiProvider } from '@prisma/client';
import { OrgCredentialsService } from './org-credentials.service';
import type { PrismaService } from '../../database/prisma.service';
import type { CryptoService } from './crypto.service';
import type { CredentialAuditService } from './audit.service';
import type { CredentialEventsBus } from './credential-events';

/**
 * Fix CodeRabbit #2: validação de routing por ALLOWLIST fail-closed. EMBEDDINGS
 * e TRANSCRIPTION só suportam OPENAI (único com implementação real — Whisper).
 * Provider novo no enum não "vaza" como suportado.
 */

function makeService() {
  const upsert = jest.fn((args: { create: unknown }) => Promise.resolve(args.create));
  const prisma = {
    organizationCapabilityRouting: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert,
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  } as unknown as PrismaService;
  const crypto = {} as unknown as CryptoService;
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as CredentialAuditService;
  const events = { emit: jest.fn() } as unknown as CredentialEventsBus;
  return new OrgCredentialsService(prisma, crypto, audit, events);
}

const update = (capability: AiCapability, providerSelected: AiProvider) =>
  makeService().updateRouting('org1', [{ capability, providerSelected }], 'user1');

describe('OrgCredentialsService.updateRouting — allowlist fail-closed', () => {
  describe('TRANSCRIPTION só permite OPENAI', () => {
    it.each([
      AiProvider.GEMINI, // stub não-implementado — antes vazava (fail-open)
      AiProvider.KIMI,
      AiProvider.ZAI,
      AiProvider.ANTHROPIC,
    ])('rejeita %s', async (provider) => {
      await expect(update(AiCapability.TRANSCRIPTION, provider)).rejects.toThrow(
        ConflictException,
      );
    });

    it('aceita OPENAI', async () => {
      await expect(
        update(AiCapability.TRANSCRIPTION, AiProvider.OPENAI),
      ).resolves.toBeDefined();
    });
  });

  describe('EMBEDDINGS só permite OPENAI', () => {
    it.each([AiProvider.GEMINI, AiProvider.KIMI, AiProvider.ZAI, AiProvider.ANTHROPIC])(
      'rejeita %s',
      async (provider) => {
        await expect(update(AiCapability.EMBEDDINGS, provider)).rejects.toThrow(
          ConflictException,
        );
      },
    );

    it('aceita OPENAI', async () => {
      await expect(
        update(AiCapability.EMBEDDINGS, AiProvider.OPENAI),
      ).resolves.toBeDefined();
    });
  });

  describe('LLM_AGENT permanece flexível (KIMI/ZAI/GEMINI válidos)', () => {
    it.each([
      AiProvider.ANTHROPIC,
      AiProvider.OPENAI,
      AiProvider.GEMINI,
      AiProvider.KIMI,
      AiProvider.ZAI,
    ])('aceita %s', async (provider) => {
      await expect(update(AiCapability.LLM_AGENT, provider)).resolves.toBeDefined();
    });
  });
});
