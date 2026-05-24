import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsString } from 'class-validator';

export class ForwardMessageDto {
  @ApiProperty({
    description: 'IDs internos das conversas-destino. Mínimo 1, máximo 20 por chamada (cap defensivo contra rate-limit Zappfy).',
    example: ['conv_123', 'conv_456'],
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'destinationConversationIds deve ter pelo menos 1 destino' })
  @ArrayMaxSize(20, { message: 'máximo de 20 destinos por chamada' })
  @ArrayUnique({ message: 'destinos duplicados não permitidos' })
  @IsString({ each: true })
  destinationConversationIds!: string[];
}
