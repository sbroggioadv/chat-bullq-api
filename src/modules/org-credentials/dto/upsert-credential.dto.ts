import {
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Matches,
  MinLength,
} from 'class-validator';

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
 */
export class UpsertCredentialDto {
  @IsString()
  @MinLength(10, { message: 'apiKey too short (min 10 chars)' })
  @MaxLength(500, { message: 'apiKey too long (max 500 chars)' })
  // No whitespace embedded (defensive: prevents copy-paste leading/trailing).
  @Matches(/^\S+$/, { message: 'apiKey cannot contain whitespace' })
  apiKey!: string;

  @IsOptional()
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'baseUrl must be a valid http(s) URL' },
  )
  @MaxLength(300, { message: 'baseUrl too long (max 300 chars)' })
  baseUrl?: string;
}
