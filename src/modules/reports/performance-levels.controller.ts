import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { AuthUser } from '../../common/interfaces/auth-user.interface';
import {
  PerformanceLevelsResponseDto,
  ReplacePerformanceLevelsDto,
} from './dto/performance-level.dto';
import {
  PERFORMANCE_LEVELS_PERMISSION,
  PerformanceLevelsService,
} from './performance-levels.service';

@ApiTags('performance-levels')
@ApiCookieAuth('access_token')
@ApiForbiddenResponse({ description: 'Sin permiso para esta acción' })
@Controller('performance-levels')
export class PerformanceLevelsController {
  constructor(private readonly levels: PerformanceLevelsService) {}

  @Get()
  @RequirePermission(PERFORMANCE_LEVELS_PERMISSION, 'view')
  @ApiOperation({
    summary: 'Niveles de desempeño de la institución activa',
    description: 'Con la escala de notas de la institución.',
  })
  @ApiOkResponse({ type: PerformanceLevelsResponseDto })
  findAll(
    @CurrentUser() user: AuthUser,
  ): Promise<PerformanceLevelsResponseDto> {
    return this.levels.findAll(user);
  }

  @Put()
  @RequirePermission(PERFORMANCE_LEVELS_PERMISSION, 'update')
  @ApiOperation({
    summary: 'Reemplazar los niveles de desempeño',
    description:
      'Reemplaza el juego completo. Deben cubrir toda la escala sin huecos ni cruces. Requiere alcance en toda la institución.',
  })
  @ApiOkResponse({ type: PerformanceLevelsResponseDto })
  @ApiBadRequestResponse({
    description: 'Niveles repetidos, con huecos, cruzados o fuera de la escala',
  })
  replace(
    @CurrentUser() user: AuthUser,
    @Body() dto: ReplacePerformanceLevelsDto,
  ): Promise<PerformanceLevelsResponseDto> {
    return this.levels.replace(user, dto);
  }
}
