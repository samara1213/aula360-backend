import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { activeInstitutionId } from '../../common/utils/active-institution';
import { requireInstitutionWideWrite } from '../academic/academic.shared';
import { toScale } from '../evaluations/scores.service';
import { InstitutionEntity } from '../institutions/entities/institution.entity';
import { PermissionsReader } from '../security/permissions-reader.service';
import {
  PerformanceLevelDto,
  PerformanceLevelsResponseDto,
  ReplacePerformanceLevelsDto,
} from './dto/performance-level.dto';
import { PerformanceLevelEntity } from './entities/performance-level.entity';
import { replaceLevels, validateLevels } from './performance-levels.rules';

export const PERFORMANCE_LEVELS_PERMISSION = 'academic.performance-levels';

/**
 * Niveles de desempeño de la institución activa (Decreto 1290). Se
 * reemplazan completos y solo con alcance en toda la institución. La
 * institución se bloquea FOR UPDATE: dos reemplazos o un cambio de escala a
 * la vez se serializan.
 */
@Injectable()
export class PerformanceLevelsService {
  private readonly logger = new Logger(PerformanceLevelsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionsReader,
  ) {}

  async findAll(user: AuthUser): Promise<PerformanceLevelsResponseDto> {
    return this.read(this.dataSource.manager, activeInstitutionId(user));
  }

  async replace(
    user: AuthUser,
    dto: ReplacePerformanceLevelsDto,
  ): Promise<PerformanceLevelsResponseDto> {
    const institutionId = await requireInstitutionWideWrite(
      this.permissions,
      user,
      PERFORMANCE_LEVELS_PERMISSION,
      'update',
    );
    const { result, before } = await this.dataSource.transaction(
      async (manager) => {
        const institution = await manager
          .getRepository(InstitutionEntity)
          .findOneOrFail({
            where: { id: institutionId },
            lock: { mode: 'pessimistic_write' },
          });
        const levels = validateLevels(dto.levels, institution);
        const previous = await this.read(manager, institutionId, institution);
        await replaceLevels(manager, institutionId, levels);
        return {
          result: await this.read(manager, institutionId, institution),
          before: previous.levels,
        };
      },
    );
    // Después del commit (hallazgo B5 de la fase 10a).
    const summary = (
      levels: { name: string; minScore: number; maxScore: number }[],
    ) => levels.map((l) => `${l.name} ${l.minScore}-${l.maxScore}`);
    this.logger.log(
      JSON.stringify({
        audit: 'performance-levels.replaced',
        actorId: user.userId,
        institutionId,
        before: summary(before),
        after: summary(result.levels),
      }),
    );
    return result;
  }

  private async read(
    manager: EntityManager,
    institutionId: string,
    institution?: InstitutionEntity,
  ): Promise<PerformanceLevelsResponseDto> {
    const found =
      institution ??
      (await manager
        .getRepository(InstitutionEntity)
        .findOneByOrFail({ id: institutionId }));
    const levels = await manager.getRepository(PerformanceLevelEntity).find({
      where: { institutionId },
      order: { minScore: 'ASC' },
    });
    return {
      scale: toScale(found),
      levels: levels.map((level) => PerformanceLevelDto.from(level)),
    };
  }
}
