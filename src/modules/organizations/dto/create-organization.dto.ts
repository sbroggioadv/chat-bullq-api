import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * S19 Wave 3: payload pra criar uma nova organizacao (workspace).
 *
 * Apenas `name` e obrigatorio — slug e gerado server-side via slugify + suffix
 * unico (mesmo pattern de auth.service.registerNewWorkspace). Demais campos
 * (plan, brand, themeTokens, settings) herdam defaults do schema Prisma:
 *   - plan: "free"
 *   - settings: {} (jsonb)
 *   - brand: null (onboarding wizard mostra A/B/C na primeira entrada)
 *
 * Usuario que cria vira OWNER da org nova. Department "Geral" default e
 * criado dentro da mesma transacao pra evitar estado intermediario inutil.
 */
export class CreateOrganizationDto {
  @ApiProperty({ example: 'Sbroggio Advocacia Empresarial' })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  name!: string;
}
