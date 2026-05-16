import { AiCapability, AiProvider } from '@prisma/client';
import { IsArray, IsEnum, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Sentinel para "usar ENV global fallback" sem prover credential org-level.
 * Mapeia internamente pra ausência de OrganizationCredential (mesmo path
 * gracioso do resolver).
 */
export const ENV_FALLBACK = 'ENV_FALLBACK' as const;

export class RoutingEntryDto {
  @IsEnum(AiCapability)
  capability!: AiCapability;

  @IsEnum(AiProvider)
  providerSelected!: AiProvider;

  @IsOptional()
  @IsString()
  modelOverride?: string;
}

export class UpdateRoutingDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoutingEntryDto)
  entries!: RoutingEntryDto[];
}
