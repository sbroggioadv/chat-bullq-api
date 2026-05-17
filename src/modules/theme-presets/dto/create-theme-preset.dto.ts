/**
 * Sprint S18 Wave 4 — Theme Presets Library (Fase 1 backend)
 *
 * DTO de criação de preset nomeado. Reusa o `ThemeTokensDto` da Wave 3
 * (mesmo shape, mesma validação OKLCH/WCAG).
 */

import { IsObject, IsString, Length, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { ThemeTokensDto } from '../../organizations/dto/theme-tokens.dto';

export class CreateThemePresetDto {
  @ApiProperty({
    description: 'Nome do preset (único por organização). 1-80 chars.',
    minLength: 1,
    maxLength: 80,
    example: 'Black Friday 2026',
  })
  @IsString()
  @Length(1, 80)
  name!: string;

  @ApiProperty({
    description: 'Tokens OKLCH (base + light + dark + radius + density). Validação WCAG roda no service.',
    type: ThemeTokensDto,
  })
  @IsObject()
  @ValidateNested()
  @Type(() => ThemeTokensDto)
  tokens!: ThemeTokensDto;
}
