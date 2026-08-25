import { Allow, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

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

export class PostActivityDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  name!: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dueDate?: string;
}
