import { PartialType } from '@nestjs/swagger';
import { CreateCampusDto } from './create-campus.dto';

export class UpdateCampusDto extends PartialType(CreateCampusDto) {}
