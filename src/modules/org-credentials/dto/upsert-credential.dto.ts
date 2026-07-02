import { IsOptional, IsString, MaxLength, Matches, MinLength } from 'class-validator';
import { IsAllowedProviderBaseUrl } from '../../ai-agents/providers/provider-baseurl-guard';

/**
 * Body para PUT /organizations/current/credentials/:provider.
 *
 * `apiKey` é a key crua do provider. Validamos só shape básico (não-vazio,
 * sem whitespace, comprimento razoável). O test endpoint é quem valida
 * semântica (key efetivamente funciona contra o provider).
 *
 * `baseUrl` (opcional) permite endpoint OpenAI-compatible custom por
 * credencial — ex: endpoint China da Moonshot (`api.moonshot.cn`) / Zhipu
 * (`open.bigmodel.cn`) ou proxy self-hosted. Ausente => resolver usa o
 * default do provider.
 *
 * SSRF guard: `baseUrl` é validado contra uma allowlist de hosts de providers
 * conhecidos (match exato, https-only, sem IP privado/loopback) — ver
 * provider-baseurl-guard. Sem isso, um baseUrl interno transformaria o server
 * num proxy SSRF (o adapter faz fetch autenticado nesse host).
 */
export class UpsertCredentialDto {
  @IsString()
  @MinLength(10, { message: 'apiKey too short (min 10 chars)' })
  @MaxLength(500, { message: 'apiKey too long (max 500 chars)' })
  // No whitespace embedded (defensive: prevents copy-paste leading/trailing).
  @Matches(/^\S+$/, { message: 'apiKey cannot contain whitespace' })
  apiKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300, { message: 'baseUrl too long (max 300 chars)' })
  @IsAllowedProviderBaseUrl()
  baseUrl?: string;
}
