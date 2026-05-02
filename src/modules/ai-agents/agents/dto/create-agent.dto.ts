import { AiAgentKind } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateAgentDto {
  @ApiProperty({ example: 'Atendente de Vendas' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @ApiPropertyOptional({ enum: AiAgentKind, default: AiAgentKind.WORKER })
  @IsOptional()
  @IsEnum(AiAgentKind)
  kind?: AiAgentKind;

  @ApiPropertyOptional({ example: 'vendas' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['responde sobre planos', 'faz follow-up de orçamentos'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  capabilities?: string[];

  @ApiProperty({ example: 'anthropic/claude-sonnet-4-6' })
  @IsString()
  modelId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  modelParams?: Record<string, unknown>;

  @ApiProperty({ example: 'Você é um vendedor consultivo da Bravy School...' })
  @IsString()
  @MinLength(10)
  systemPrompt!: string;

  @ApiPropertyOptional({ default: 0.7 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @ApiPropertyOptional({ default: 2048 })
  @IsOptional()
  @IsInt()
  @Min(64)
  @Max(8192)
  maxTokens?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  canRespondDirectly?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
