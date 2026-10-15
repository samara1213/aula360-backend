import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateMenuOptionDto } from './create-menu-option.dto';

/** El slug no se puede cambiar: es la clave de permiso que usa el código. */
export class UpdateMenuOptionDto extends PartialType(
  OmitType(CreateMenuOptionDto, ['slug'] as const),
) {}
