import { PartialType } from '@nestjs/swagger';
import { CreateAgentDto } from './create-agent.dto';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateAgentDto extends PartialType(CreateAgentDto) {
  // ─── S22 — Scope & Cadence fields ─────────────────────────────

  @ApiPropertyOptional({ type: [String], description: 'IDs de pipelines onde este agente atua' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pipelineScope?: string[];

  @ApiPropertyOptional({ pattern: '^[a-z0-9_-]+$', description: 'Handle @mention em grupos (único na org)' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  @Matches(/^[a-z0-9_-]+$/, { message: 'mentionHandle só aceita letras minúsculas, dígitos, _ ou -' })
  mentionHandle?: string | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  rateLimitPerHour?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  consecutiveMsgCap?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  humanizationEnabled?: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: 300000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(300_000)
  minDelayMs?: number;
}
