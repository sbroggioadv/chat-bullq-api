import { Global, Module } from '@nestjs/common';
import { CredentialAuditService } from './audit.service';
import { CredentialEventsBus } from './credential-events';
import { CredentialTestThrottleGuard } from './credential-test.throttle.guard';
import { CryptoService } from './crypto.service';
import {
  OrgCapabilityRoutingController,
  OrgCredentialsController,
} from './org-credentials.controller';
import { OrgCredentialsService } from './org-credentials.service';

/**
 * Módulo global (S18 Wave 2) — qualquer outro módulo pode injetar
 * `OrgCredentialsService` (chave decifrada via `getDecryptedKey`)
 * sem precisar importar OrgCredentialsModule explicitamente.
 *
 * Razão: o `ProviderResolverService` (em ai-agents/providers/) precisa
 * acessar credentials a partir de qualquer chamada de LLM/transcription/
 * embeddings. Tornar global evita import circular e simplifica DI.
 */
@Global()
@Module({
  controllers: [OrgCredentialsController, OrgCapabilityRoutingController],
  providers: [
    CryptoService,
    CredentialAuditService,
    CredentialEventsBus,
    CredentialTestThrottleGuard,
    OrgCredentialsService,
  ],
  exports: [
    CryptoService,
    CredentialAuditService,
    CredentialEventsBus,
    OrgCredentialsService,
  ],
})
export class OrgCredentialsModule {}
