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
import { markReportCardsOutdated } from './report-card-locks';

export const PERFORMANCE_LEVELS_PERMISSION = 'academic.performance-levels';

/**
 * Niveles de desempeño de la institución activa (Decreto 1290). Se
 * reemplazan completos y solo con alcance en toda la institución. La
 * institución se bloquea FOR UPDATE: dos reemplazos o un cambio de escala a
 * la vez se serializan. Cambian el nivel impreso: los boletines de los años
 * activos quedan desactualizados (el generador lee la institución FOR SHARE;
 * hallazgo M2 de la fase 10b).
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
    const { result, before, outdated } = await this.dataSource.transaction(
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
        const after = await this.read(manager, institutionId, institution);
        const same =
          JSON.stringify(levelSummary(previous.levels)) ===
          JSON.stringify(levelSummary(after.levels));
        return {
          result: after,
          before: previous.levels,
          outdated: same
            ? []
            : await markReportCardsOutdated(manager, { institutionId }),
        };
      },
    );
    // Después del commit (hallazgo B5 de la fase 10a).
    this.logger.log(
      JSON.stringify({
        audit: 'performance-levels.replaced',
        actorId: user.userId,
        institutionId,
        before: levelSummary(before),
        after: levelSummary(result.levels),
      }),
    );
    if (outdated.length) {
      this.logger.log(
        JSON.stringify({
          audit: 'report-cards.outdated',
          reason: 'performance-levels.replaced',
          actorId: user.userId,
          institutionId,
          reportCardIds: outdated,
        }),
      );
    }
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

const levelSummary = (
  levels: { name: string; minScore: number; maxScore: number }[],
) => levels.map((l) => `${l.name} ${l.minScore}-${l.maxScore}`);
