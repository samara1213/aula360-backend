import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class LoginDto {
  @ApiProperty({
    description: 'Email o número de documento',
    example: 'admin@colegio.edu.co',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  identifier: string;

  @ApiPropertyOptional({
    description:
      'Tipo de documento. Solo hace falta si el número existe con varios tipos.',
    example: 'CC',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  documentType?: string;

  @ApiProperty({ example: 'Aula360*Segura' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(72)
  password: string;
}
