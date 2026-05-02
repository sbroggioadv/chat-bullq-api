import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpsertCustomToolDto {
  @ApiProperty({ example: 'unlockCourseAccess' })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  @Matches(/^[a-zA-Z][a-zA-Z0-9_]*$/, {
    message:
      'Tool name must start with a letter and contain only letters, digits or underscores (the LLM uses this as a function name).',
  })
  name!: string;

  @ApiProperty()
  @IsString()
  @MinLength(10)
  description!: string;

  @ApiProperty({
    description:
      'JSON Schema descrevendo os parâmetros de entrada. Ex: {"type":"object","properties":{"email":{"type":"string"}},"required":["email"]}',
  })
  @IsObject()
  parameters!: Record<string, unknown>;

  @ApiProperty({
    enum: ['CUSTOM_HTTP', 'CUSTOM_SQL'],
    default: 'CUSTOM_HTTP',
    description: 'Tipo da tool. CUSTOM_HTTP = chamada HTTP. CUSTOM_SQL = query Postgres.',
  })
  @IsIn(['CUSTOM_HTTP', 'CUSTOM_SQL'])
  source!: 'CUSTOM_HTTP' | 'CUSTOM_SQL';

  // ── HTTP fields (obrigatórios quando source=CUSTOM_HTTP) ──────

  @ApiPropertyOptional({ example: 'POST' })
  @IsOptional()
  @IsString()
  @Matches(/^(GET|POST|PUT|PATCH|DELETE)$/i)
  httpMethod?: string;

  @ApiPropertyOptional({ example: 'https://members.bravy.com.br/api/admin/access' })
  @IsOptional()
  @IsString()
  httpUrl?: string;

  @ApiPropertyOptional({
    description: 'Headers como objeto. Templates suportados: {{env.X}}, {{input.x}}, {{ctx.x}}.',
  })
  @IsOptional()
  @IsObject()
  httpHeaders?: Record<string, string>;

  @ApiPropertyOptional({
    description:
      'Body template (string). Suporta os mesmos templates dos headers. JSON cru funciona.',
  })
  @IsOptional()
  @IsString()
  httpBodyTemplate?: string;

  @ApiPropertyOptional({
    description:
      'Mapeamento da resposta usando JSONPath simples: {"ok":"$.success","msg":"$.data.message"}',
  })
  @IsOptional()
  @IsObject()
  responseMap?: Record<string, string>;

  // ── SQL fields (obrigatórios quando source=CUSTOM_SQL) ────────

  @ApiPropertyOptional({
    description:
      'Nome da env var no servidor (ex: HOTWEBINAR_DB_URL) que contém a connection string Postgres. NÃO cole a string direto aqui — use env por segurança.',
  })
  @IsOptional()
  @IsString()
  sqlConnectionRef?: string;

  @ApiPropertyOptional({
    description:
      'Query SQL parametrizada usando $1, $2, ... Ex: SELECT * FROM users WHERE email = $1 LIMIT 1',
  })
  @IsOptional()
  @IsString()
  sqlQuery?: string;

  @ApiPropertyOptional({
    description:
      'Lista ordenada de mapeamento de parâmetros — cada entry corresponde a $1, $2, ... source: "input.x" | "ctx.x" | "literal:foo"',
    example: [{ name: 'email', source: 'input.email' }],
  })
  @IsOptional()
  @IsArray()
  sqlParamMap?: Array<{ name?: string; source: string }>;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  sqlReadOnly?: boolean;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  sqlMaxRows?: number;

  // ── Common ────────────────────────────────────────────────────

  @ApiPropertyOptional({ default: 15000 })
  @IsOptional()
  @IsInt()
  @Min(500)
  @Max(60000)
  timeoutMs?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
