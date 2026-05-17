/**
 * Sprint S18 Wave 4 — Theme Presets Library (Fase 1 backend)
 *
 * DTO de update parcial. Pelo menos 1 campo precisa vir — service rejeita
 * payload vazio (mesma validação manual que outros patches do projeto).
 */

import {
  IsObject,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ThemeTokensDto } from '../../organizations/dto/theme-tokens.dto';

export class UpdateThemePresetDto {
  @ApiPropertyOptional({
    description: 'Novo nome do preset (único por org, 1-80 chars).',
    minLength: 1,
    maxLength: 80,
  })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  name?: string;

  @ApiPropertyOptional({
    description: 'Novos tokens OKLCH. Validação WCAG roda no service.',
    type: ThemeTokensDto,
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ThemeTokensDto)
  tokens?: ThemeTokensDto;
}
