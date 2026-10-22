import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  ValidateBy,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const trimUpper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

const hasDocument = (o: UserLookupQueryDto) =>
  o.documentType !== undefined || o.documentNumber !== undefined;

/**
 * Búsqueda exacta de un usuario: por correo, o por tipo y número de documento
 * (los dos). Nunca por texto parcial: no sirve para recorrer usuarios.
 */
export class UserLookupQueryDto {
  @ApiPropertyOptional({
    example: 'ana@colegio.edu.co',
    maxLength: 255,
    description: 'Correo completo (sin distinguir mayúsculas). O el documento.',
  })
  // Cada campo que llega se valida (también un parámetro repetido, que llega
  // como lista); el correo y el documento se excluyen entre sí.
  @ValidateIf(
    (o: UserLookupQueryDto) => o.email !== undefined || !hasDocument(o),
  )
  @Transform(trim)
  @ValidateBy({
    name: 'emailOrDocument',
    validator: {
      validate: (_value: unknown, args) =>
        !hasDocument(args?.object as UserLookupQueryDto),
      defaultMessage: () => 'Busque por correo o por documento, no por los dos',
    },
  })
  @IsEmail({}, { message: 'Escriba un correo válido o el documento' })
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({
    example: 'CC',
    maxLength: 20,
    description: 'Tipo de documento (con documentNumber, si no hay email)',
  })
  @ValidateIf(
    (o: UserLookupQueryDto) =>
      o.email === undefined || o.documentType !== undefined,
  )
  @Transform(trimUpper)
  @IsString()
  @Matches(/^[A-Z]{1,20}$/, { message: 'documentType solo admite letras' })
  documentType?: string;

  @ApiPropertyOptional({
    example: '1020304050',
    maxLength: 50,
    description: 'Número de documento completo (con documentType)',
  })
  @ValidateIf(
    (o: UserLookupQueryDto) =>
      o.email === undefined || o.documentNumber !== undefined,
  )
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[0-9A-Za-z-]+$/, {
    message: 'documentNumber solo admite números, letras y guiones',
  })
  documentNumber?: string;
}

/** Lo justo para confirmar que es la persona y asignarle un rol. */
export class UserLookupResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiProperty({ example: 'CC' })
  documentType: string;

  @ApiProperty({ example: '1020304050' })
  documentNumber: string;

  @ApiProperty({ type: String, nullable: true })
  email: string | null;
}
