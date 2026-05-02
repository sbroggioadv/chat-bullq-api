import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateOrganizationDto {
  @ApiPropertyOptional({ example: 'My Company' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  logoUrl?: string;

  // ─── AI settings ────────────────────────────────────────────────

  @ApiPropertyOptional({ description: 'Master kill switch for AI agents' })
  @IsOptional()
  @IsBoolean()
  aiEnabled?: boolean;

  @ApiPropertyOptional({ example: 'America/Sao_Paulo' })
  @IsOptional()
  @IsString()
  aiTimezone?: string;

  @ApiPropertyOptional({
    description:
      'Business hours by weekday. Object with monday..sunday keys, each {enabled, windows: [["09:00","18:00"]]}.',
  })
  @IsOptional()
  @IsObject()
  aiBusinessHours?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Message sent automatically when an inbound arrives outside business hours. Empty = no auto-reply.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  aiOutOfHoursMessage?: string;

  @ApiPropertyOptional({
    description:
      'When true, AI is auto-paused on a conversation as soon as a human sends a reply.',
  })
  @IsOptional()
  @IsBoolean()
  aiAutoDisableOnHuman?: boolean;

  @ApiPropertyOptional({
    description: 'Monthly LLM token cap across the org. null = unlimited.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  aiMonthlyTokenCap?: number;
}
