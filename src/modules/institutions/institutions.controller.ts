import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  RequirePermission,
  SuperAdminOnly,
} from '../../common/decorators/require-permission.decorator';
import { ListQueryDto } from '../../common/dto/list-query.dto';
import type { AuthUser } from '../../common/interfaces/auth-user.interface';
import { activeInstitutionId } from '../../common/utils/active-institution';
import { CreateInstitutionDto } from './dto/create-institution.dto';
import {
  InstitutionPageDto,
  InstitutionResponseDto,
} from './dto/institution-response.dto';
import { UpdateInstitutionDto } from './dto/update-institution.dto';
import { InstitutionsService } from './institutions.service';

@ApiTags('institutions')
@ApiCookieAuth('access_token')
@ApiForbiddenResponse({ description: 'Sin permiso para esta acción' })
@Controller('institutions')
export class InstitutionsController {
  constructor(private readonly institutions: InstitutionsService) {}

  // Va antes de ':id' para que 'current' no se interprete como id.
  @Get('current')
  @RequirePermission('institution', 'view')
  @ApiOperation({ summary: 'Institución activa del usuario' })
  @ApiOkResponse({ type: InstitutionResponseDto })
  findCurrent(@CurrentUser() user: AuthUser): Promise<InstitutionResponseDto> {
    return this.institutions.findOne(activeInstitutionId(user));
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
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InstitutionResponseDto> {
    return this.institutions.setActive(id, false);
  }

  @Patch(':id/activate')
  @SuperAdminOnly()
  @ApiOperation({ summary: 'Reactivar institución (SUPER_ADMIN)' })
  @ApiOkResponse({ type: InstitutionResponseDto })
  @ApiNotFoundResponse({ description: 'Institución no encontrada' })
  activate(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InstitutionResponseDto> {
    return this.institutions.setActive(id, true);
  }
}
