import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UPLOAD_THROTTLE } from '../../common/constants/throttle';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  RequirePermission,
  SuperAdminOnly,
} from '../../common/decorators/require-permission.decorator';
import { ListQueryDto } from '../../common/dto/list-query.dto';
import type { AuthUser } from '../../common/interfaces/auth-user.interface';
import { activeInstitutionId } from '../../common/utils/active-institution';
import { ImageFilePipe, ValidatedFile } from '../../storage/image-file.pipe';
import { ImageUpload } from '../../storage/image-upload.decorator';
import { CreateInstitutionDto } from './dto/create-institution.dto';
import {
  InstitutionPageDto,
  InstitutionResponseDto,
} from './dto/institution-response.dto';
import { UpdateInstitutionDto } from './dto/update-institution.dto';
import {
  INSTITUTION_PERMISSION,
  InstitutionsService,
} from './institutions.service';

@ApiTags('institutions')
@ApiForbiddenResponse({ description: 'Sin permiso para esta acción' })
@Controller('institutions')
export class InstitutionsController {
  constructor(private readonly institutions: InstitutionsService) {}

  // Va antes de ':id' para que 'current' no se interprete como id.
  @Get('current')
  @RequirePermission(INSTITUTION_PERMISSION, 'view')
  @ApiOperation({ summary: 'Institución activa del usuario' })
  @ApiOkResponse({ type: InstitutionResponseDto })
  findCurrent(@CurrentUser() user: AuthUser): Promise<InstitutionResponseDto> {
    return this.institutions.findOne(activeInstitutionId(user));
  }

  @Put('current/logo')
  @Throttle(UPLOAD_THROTTLE)
  @RequirePermission(INSTITUTION_PERMISSION, 'update')
  @ImageUpload()
  @ApiOperation({
    summary: 'Subir o cambiar el logo de la institución activa',
    description:
      'Requiere el permiso en toda la institución (no solo en una sede). El logo es público.',
  })
  @ApiOkResponse({ type: InstitutionResponseDto })
  replaceCurrentLogo(
    @CurrentUser() user: AuthUser,
    @UploadedFile(ImageFilePipe) file: ValidatedFile,
  ): Promise<InstitutionResponseDto> {
    return this.institutions.replaceCurrentLogo(user, file);
  }

  @Delete('current/logo')
  @Throttle(UPLOAD_THROTTLE)
  @RequirePermission(INSTITUTION_PERMISSION, 'update')
  @ApiOperation({ summary: 'Quitar el logo de la institución activa' })
  @ApiOkResponse({ type: InstitutionResponseDto })
  removeCurrentLogo(
    @CurrentUser() user: AuthUser,
  ): Promise<InstitutionResponseDto> {
    return this.institutions.removeCurrentLogo(user);
  }

  @Get()
  @SuperAdminOnly()
  @ApiOperation({ summary: 'Listar instituciones (SUPER_ADMIN)' })
  @ApiOkResponse({ type: InstitutionPageDto })
  findAll(@Query() query: ListQueryDto) {
    return this.institutions.findAll(query);
  }

  @Get(':id')
  @SuperAdminOnly()
  @ApiOperation({ summary: 'Ver una institución (SUPER_ADMIN)' })
  @ApiOkResponse({ type: InstitutionResponseDto })
  @ApiNotFoundResponse({ description: 'Institución no encontrada' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InstitutionResponseDto> {
    return this.institutions.findOne(id);
  }

  @Post()
  @SuperAdminOnly()
  @ApiOperation({ summary: 'Crear institución (SUPER_ADMIN)' })
  @ApiCreatedResponse({ type: InstitutionResponseDto })
  @ApiBadRequestResponse({
    description: 'Datos inválidos o escala incoherente',
  })
  @ApiConflictResponse({ description: 'Ya existe una institución con ese NIT' })
  create(@Body() dto: CreateInstitutionDto): Promise<InstitutionResponseDto> {
    return this.institutions.create(dto);
  }

  @Patch(':id')
  @SuperAdminOnly()
  @ApiOperation({
    summary: 'Editar institución (SUPER_ADMIN)',
    description:
      'La escala de notas no se puede cambiar si la institución ya tiene notas registradas.',
  })
  @ApiOkResponse({ type: InstitutionResponseDto })
  @ApiBadRequestResponse({
    description: 'Datos inválidos o escala incoherente',
  })
  @ApiNotFoundResponse({ description: 'Institución no encontrada' })
  @ApiConflictResponse({
    description: 'NIT duplicado o escala bloqueada por notas existentes',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInstitutionDto,
  ): Promise<InstitutionResponseDto> {
    return this.institutions.update(id, dto);
  }

  @Put(':id/logo')
  @Throttle(UPLOAD_THROTTLE)
  @SuperAdminOnly()
  @ImageUpload()
  @ApiOperation({ summary: 'Subir o cambiar el logo (SUPER_ADMIN)' })
  @ApiOkResponse({ type: InstitutionResponseDto })
  @ApiNotFoundResponse({ description: 'Institución no encontrada' })
  replaceLogo(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile(ImageFilePipe) file: ValidatedFile,
  ): Promise<InstitutionResponseDto> {
    return this.institutions.replaceLogo(id, file);
  }

  @Delete(':id/logo')
  @Throttle(UPLOAD_THROTTLE)
  @SuperAdminOnly()
  @ApiOperation({ summary: 'Quitar el logo (SUPER_ADMIN)' })
  @ApiOkResponse({ type: InstitutionResponseDto })
  @ApiNotFoundResponse({ description: 'Institución no encontrada' })
  removeLogo(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InstitutionResponseDto> {
    return this.institutions.removeLogo(id);
  }

  @Patch(':id/deactivate')
  @SuperAdminOnly()
  @ApiOperation({
    summary: 'Desactivar institución (SUPER_ADMIN)',
    description:
      'Desactivación lógica: sus usuarios dejan de poder operar en ella.',
  })
  @ApiOkResponse({ type: InstitutionResponseDto })
  @ApiNotFoundResponse({ description: 'Institución no encontrada' })
  deactivate(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InstitutionResponseDto> {
    return this.institutions.setActive(user, id, false);
  }

  @Patch(':id/activate')
  @SuperAdminOnly()
  @ApiOperation({ summary: 'Reactivar institución (SUPER_ADMIN)' })
  @ApiOkResponse({ type: InstitutionResponseDto })
  @ApiNotFoundResponse({ description: 'Institución no encontrada' })
  activate(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InstitutionResponseDto> {
    return this.institutions.setActive(user, id, true);
  }
}
