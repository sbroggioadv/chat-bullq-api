import { Allow, IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class PatchStatusDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  status!: string;
}

export class PatchFieldDto {
  @Allow()
  value!: unknown;
}

export class PostCommentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  oQue!: string;

  @IsString()
  @MaxLength(2_000)
  proximoPasso!: string;
}

export class BindGroupTaskDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  taskRef!: string;
}

export class CreateGroupTaskDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,128}$/)
  listId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  name!: string;
}

export class BindWorkbenchDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  taskRef!: string;

  @IsOptional()
  @IsBoolean()
  crossLinkDossier?: boolean;

  @IsOptional()
  @IsBoolean()
  confirmSwitch?: boolean;
}

export class CreateWorkbenchTaskDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,128}$/)
  listId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  name!: string;

  @IsOptional()
  @IsBoolean()
  crossLinkDossier?: boolean;

  @IsOptional()
  @IsBoolean()
  confirmSwitch?: boolean;
}

export class CreateLeadDto {
  @IsOptional()
  @IsBoolean()
  confirmSwitch?: boolean;
}

export class PostActivityDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  name!: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dueDate?: string;
}
