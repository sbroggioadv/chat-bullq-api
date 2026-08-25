import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  fingerprintPerfil,
  listaPrincipal,
  validarPerfil,
  type ClickUpInboxProfile,
} from './domain/perfil';
import { idSeguro } from './domain/ids';
import { notConfigured } from './clickup-inbox.errors';

export type LocalConfigOk = {
  ok: true;
  apiKey: string;
  teamId: string;
  organizationId: string;
  profile: ClickUpInboxProfile;
  fingerprint: string;
};

export type LocalConfigFail = { ok: false; reason: string };
export type LocalConfig = LocalConfigOk | LocalConfigFail;

@Injectable()
export class ClickUpInboxConfigService {
  private readonly local: LocalConfig;
  private remote: { ok: true } | { ok: false; reason: string } | null = null;
  private remoteInflight: Promise<void> | null = null;

  constructor(config: ConfigService) {
    this.local = parseLocalConfig(config);
  }

  snapshot(): LocalConfig {
    return this.local;
  }

  assertLocal(): LocalConfigOk {
    if (!this.local.ok) notConfigured(this.local.reason);
    return this.local;
  }

  authorizedOrganizationId(): string | null {
    return this.local.ok ? this.local.organizationId : null;
  }

  profile(): ClickUpInboxProfile {
    return this.assertLocal().profile;
  }

  fingerprint(): string {
    return this.assertLocal().fingerprint;
  }

  primaryListId(): string {
    return listaPrincipal(this.assertLocal().profile);
  }

  markRemoteUnchecked() {
    this.remote = null;
  }

  async ensureRemote(run: () => Promise<void>): Promise<void> {
    this.assertLocal();
    if (this.remote?.ok) return;
    if (this.remote && !this.remote.ok) notConfigured(this.remote.reason);
    if (this.remoteInflight) return this.remoteInflight;
    this.remoteInflight = this.run(run).finally(() => {
      this.remoteInflight = null;
    });
    return this.remoteInflight;
  }

  private async run(run: () => Promise<void>): Promise<void> {
    try {
      await run();
      this.remote = { ok: true };
    } catch (err) {
      const reason = extractReason(err);
      this.remote = { ok: false, reason };
      notConfigured(reason);
    }
  }
}

export function parseLocalConfig(config: Pick<ConfigService, 'get'>): LocalConfig {
  const apiKey = trimOrEmpty(config.get<string>('CLICKUP_API_KEY'));
  const teamId = trimOrEmpty(config.get<string>('CLICKUP_TEAM_ID'));
  const organizationId = trimOrEmpty(config.get<string>('CLICKUP_ORGANIZATION_ID'));
  const profileJson = trimOrEmpty(config.get<string>('CLICKUP_PROFILE_JSON'));

  if (!apiKey || !teamId || !organizationId || !profileJson) {
    return { ok: false, reason: 'ClickUp não configurado' };
  }
  if (!idSeguro(teamId) || !idSeguro(organizationId)) {
    return { ok: false, reason: 'CLICKUP_TEAM_ID ou CLICKUP_ORGANIZATION_ID inválido' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(profileJson);
  } catch {
    return { ok: false, reason: 'CLICKUP_PROFILE_JSON malformado' };
  }
  const valid = validarPerfil(parsed);
  if (!valid.ok) return { ok: false, reason: valid.erro };

  return {
    ok: true,
    apiKey,
    teamId,
    organizationId,
    profile: valid.profile,
    fingerprint: fingerprintPerfil(valid.profile),
  };
}

function trimOrEmpty(value: string | undefined): string {
  return String(value ?? '').trim();
}

function extractReason(err: unknown): string {
  if (err && typeof err === 'object' && 'getResponse' in err) {
    const response = (err as { getResponse: () => unknown }).getResponse();
    if (typeof response === 'string') return response;
    if (response && typeof response === 'object' && 'message' in response) {
      return String((response as { message: unknown }).message);
    }
  }
  if (err instanceof Error && err.message) return err.message;
  return 'validação remota do ClickUp falhou';
}
