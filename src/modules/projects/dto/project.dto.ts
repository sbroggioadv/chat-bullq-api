import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export const PROJECT_PHASES = [
  'TODO',
  'WAITING_DOCS',
  'IN_PROGRESS',
  'PAUSED',
  'DONE',
] as const;

export class CreateProjectDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsIn(PROJECT_PHASES)
  status?: string;

  @IsOptional()
  @IsString()
  conversationId?: string;
}

export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  hoppeId?: string;

  @IsOptional()
  @IsString()
  responsibleUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  status?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class CreateTaskDto {
  @IsString()
  @MinLength(1)
  @MaxLength(400)
  title!: string;
}

export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  @MaxLength(400)
  title?: string;

  @IsOptional()
  @IsBoolean()
  done?: boolean;
}

export class AttachMessageDto {
  @IsString()
  messageId!: string;
}

export class AddContactDto {
  @IsString()
  contactId!: string;
}

export class LinkConversationDto {
  @IsString()
  conversationId!: string;
}

export class ProjectEmailDto {
  @IsString()
  @MinLength(1)
  subject!: string;

  @IsString()
  @MinLength(1)
  body!: string;

  @IsOptional()
  @IsString()
  to?: string;
}
