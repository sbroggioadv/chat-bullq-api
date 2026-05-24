import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateQuickReplyDto {
  @ApiProperty({ example: 'saudacao', pattern: '^[a-z0-9_-]+$' })
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  @Matches(/^[a-z0-9_-]+$/i, {
    message: 'shortcut só aceita letras, dígitos, _ ou -',
  })
  shortcut: string;

  @ApiProperty({ example: 'Saudação inicial' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title: string;

  @ApiProperty({ example: 'Olá! Tudo bem?' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content: string;
}
