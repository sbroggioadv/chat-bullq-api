import { IsString, MinLength, MaxLength, Matches } from 'class-validator';

/**
 * Body para PUT /organizations/current/credentials/:provider.
 *
 * `apiKey` é a key crua do provider. Validamos só shape básico (não-vazio,
 * sem whitespace, comprimento razoável). O test endpoint é quem valida
 * semântica (key efetivamente funciona contra o provider).
 */
export class UpsertCredentialDto {
  @IsString()
  @MinLength(10, { message: 'apiKey too short (min 10 chars)' })
  @MaxLength(500, { message: 'apiKey too long (max 500 chars)' })
  // No whitespace embedded (defensive: prevents copy-paste leading/trailing).
  @Matches(/^\S+$/, { message: 'apiKey cannot contain whitespace' })
  apiKey!: string;
}
