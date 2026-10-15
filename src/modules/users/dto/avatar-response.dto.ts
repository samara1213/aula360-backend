import { ApiProperty } from '@nestjs/swagger';

export class AvatarResponseDto {
  @ApiProperty({ description: 'Ruta del avatar en Storage (bucket privado)' })
  avatarPath: string;

  @ApiProperty({ description: 'URL firmada temporal para mostrar el avatar' })
  url: string;

  @ApiProperty({ example: 120, description: 'Segundos de validez de la URL' })
  expiresIn: number;
}
