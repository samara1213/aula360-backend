import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { containsPattern, ListQueryDto } from '../../common/dto/list-query.dto';
import {
  paginate,
  Paginated,
  toSkipTake,
} from '../../common/dto/pagination.dto';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { activeInstitutionId } from '../../common/utils/active-institution';
import { rejectNullFields } from '../../common/validators/reject-null-fields';
import { ValidatedFile } from '../../storage/image-file.pipe';
import { StorageService } from '../../storage/storage.service';
import { ScoreEntity } from '../evaluations/entities/score.entity';
import { PermissionsReader } from '../security/permissions-reader.service';
import { CreateInstitutionDto } from './dto/create-institution.dto';
import { InstitutionResponseDto } from './dto/institution-response.dto';
import { UpdateInstitutionDto } from './dto/update-institution.dto';
import { InstitutionEntity } from './entities/institution.entity';

/** Valores por defecto de la escala (iguales a los DEFAULT de la tabla). */
const DEFAULT_SCALE = {
  gradingScaleMin: 1,
  gradingScaleMax: 5,
  passingScore: 3,
};

type Scale = typeof DEFAULT_SCALE;

/** Slug de menú que controla los datos de la propia institución. */
export const INSTITUTION_PERMISSION = 'institution';

const LOGO_BUCKET = 'logos';

/**
 * Gestión de instituciones. La escritura y los listados son solo de SUPER_ADMIN
 * (el controller lo exige); el resto de usuarios lee su institución activa y,
 * con permiso de edición en toda ella, cambia su logo.
 * Nunca se borran: se desactivan (is_active), lo que corta el acceso de sus usuarios.
 */
@Injectable()
export class InstitutionsService {
  constructor(
    @InjectRepository(InstitutionEntity)
    private readonly institutions: Repository<InstitutionEntity>,
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly permissions: PermissionsReader,
  ) {}

  async findAll(
    query: ListQueryDto,
  ): Promise<Paginated<InstitutionResponseDto>> {
    const qb = this.institutions
      .createQueryBuilder('i')
      .orderBy('i.name', 'ASC')
      .addOrderBy('i.id', 'ASC');
    if (query.search) {
      qb.andWhere('(i.name ILIKE :pattern OR i.nit ILIKE :pattern)', {
        pattern: containsPattern(query.search),
      });
    }
    if (query.isActive !== undefined) {
      qb.andWhere('i.is_active = :isActive', { isActive: query.isActive });
    }
    const { skip, take } = toSkipTake(query);
    const [rows, total] = await qb.skip(skip).take(take).getManyAndCount();
    return paginate(
      rows.map((row) => this.toDto(row)),
      total,
      query,
    );
  }

  async findOne(id: string): Promise<InstitutionResponseDto> {
    return this.toDto(await this.getOrFail(id));
  }

  async create(dto: CreateInstitutionDto): Promise<InstitutionResponseDto> {
    const scale: Scale = {
      gradingScaleMin: dto.gradingScaleMin ?? DEFAULT_SCALE.gradingScaleMin,
      gradingScaleMax: dto.gradingScaleMax ?? DEFAULT_SCALE.gradingScaleMax,
      passingScore: dto.passingScore ?? DEFAULT_SCALE.passingScore,
    };
    this.assertValidScale(scale);
    const entity = this.institutions.create({
      nit: dto.nit,
      name: dto.name,
      ...scale,
    });
    return this.toDto(await this.save(entity));
  }

  async update(
    id: string,
    dto: UpdateInstitutionDto,
  ): Promise<InstitutionResponseDto> {
    rejectNullFields(dto, [
      'nit',
      'name',
      'gradingScaleMin',
      'gradingScaleMax',
      'passingScore',
    ]);
    // Transacción con la fila bloqueada: la comprobación de notas y el guardado
    // son atómicos frente a otras ediciones de la institución.
    // TODO(fase 9): el registro de notas debe bloquear la institución con FOR SHARE.
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(InstitutionEntity);
      const entity = await repo.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!entity) throw new NotFoundException('Institución no encontrada');

      const scale: Scale = {
        gradingScaleMin: dto.gradingScaleMin ?? entity.gradingScaleMin,
        gradingScaleMax: dto.gradingScaleMax ?? entity.gradingScaleMax,
        passingScore: dto.passingScore ?? entity.passingScore,
      };
      this.assertValidScale(scale);
      const scaleChanged =
        scale.gradingScaleMin !== entity.gradingScaleMin ||
        scale.gradingScaleMax !== entity.gradingScaleMax ||
        scale.passingScore !== entity.passingScore;
      if (scaleChanged && (await this.hasScores(manager, id))) {
        throw new ConflictException(
          'No se puede cambiar la escala de notas: la institución ya tiene notas registradas',
        );
      }

      if (dto.nit !== undefined) entity.nit = dto.nit;
      if (dto.name !== undefined) entity.name = dto.name;
      Object.assign(entity, scale);
      return this.toDto(await this.save(entity, repo));
    });
  }

  /** Activa o desactiva (lógico). Al desactivar, sus usuarios pierden el acceso a ella. */
  async setActive(
    id: string,
    isActive: boolean,
  ): Promise<InstitutionResponseDto> {
    const entity = await this.getOrFail(id);
    if (entity.isActive !== isActive) {
      entity.isActive = isActive;
      await this.institutions.save(entity);
    }
    return this.toDto(entity);
  }

  /** Logo de la institución activa: exige el permiso en toda la institución. */
  async replaceCurrentLogo(
    user: AuthUser,
    file: ValidatedFile,
  ): Promise<InstitutionResponseDto> {
    return this.replaceLogo(await this.currentForLogo(user), file);
  }

  async removeCurrentLogo(user: AuthUser): Promise<InstitutionResponseDto> {
    return this.removeLogo(await this.currentForLogo(user));
  }

  /**
   * Sube el logo nuevo, guarda su ruta con la fila bloqueada y después borra el
   * anterior. Si falla la BD, se borra el recién subido (no quedan huérfanos).
   */
  async replaceLogo(
    id: string,
    file: ValidatedFile,
  ): Promise<InstitutionResponseDto> {
    await this.getOrFail(id); // 404 antes de subir nada
    const path = await this.storage.upload(LOGO_BUCKET, `${id}/logos`, file);
    try {
      return await this.setLogoPath(id, path);
    } catch (error) {
      await this.storage.removeQuietly(LOGO_BUCKET, path);
      throw error;
    }
  }

  async removeLogo(id: string): Promise<InstitutionResponseDto> {
    return this.setLogoPath(id, null);
  }

  private async setLogoPath(
    id: string,
    path: string | null,
  ): Promise<InstitutionResponseDto> {
    const { saved, previous } = await this.dataSource.transaction(
      async (manager) => {
        const repo = manager.getRepository(InstitutionEntity);
        const entity = await repo.findOne({
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!entity) throw new NotFoundException('Institución no encontrada');
        const old = entity.logoPath;
        if (old === path) return { saved: entity, previous: old };
        entity.logoPath = path;
        return { saved: await repo.save(entity), previous: old };
      },
    );
    if (previous && previous !== path) {
      await this.storage.removeQuietly(LOGO_BUCKET, previous);
    }
    return this.toDto(saved);
  }

  private async currentForLogo(user: AuthUser): Promise<string> {
    const institutionId = activeInstitutionId(user);
    await this.permissions.requireInstitutionWide(
      user,
      institutionId,
      INSTITUTION_PERMISSION,
      'update',
      'Su acceso está limitado a una sede: no puede cambiar el logo',
    );
    return institutionId;
  }

  private toDto(entity: InstitutionEntity): InstitutionResponseDto {
    return InstitutionResponseDto.from(
      entity,
      this.storage.publicUrl(LOGO_BUCKET, entity.logoPath),
    );
  }

  private async getOrFail(id: string): Promise<InstitutionEntity> {
    const entity = await this.institutions.findOne({ where: { id } });
    if (!entity) throw new NotFoundException('Institución no encontrada');
    return entity;
  }

  private assertValidScale({
    gradingScaleMin,
    gradingScaleMax,
    passingScore,
  }: Scale): void {
    if (gradingScaleMin >= gradingScaleMax) {
      throw new BadRequestException(
        'gradingScaleMin debe ser menor que gradingScaleMax',
      );
    }
    if (passingScore < gradingScaleMin || passingScore > gradingScaleMax) {
      throw new BadRequestException(
        'passingScore debe estar entre gradingScaleMin y gradingScaleMax',
      );
    }
  }

  /** ¿Hay notas registradas en la institución? (scores -> ... -> grades.institution_id) */
  private hasScores(
    manager: EntityManager,
    institutionId: string,
  ): Promise<boolean> {
    return manager
      .getRepository(ScoreEntity)
      .createQueryBuilder('s')
      .innerJoin('s.evaluation', 'e')
      .innerJoin('e.teacherSubjectCourse', 'tsc')
      .innerJoin('tsc.course', 'c')
      .innerJoin('c.grade', 'g')
      .where('g.institution_id = :institutionId', { institutionId })
      .getExists();
  }

  private async save(
    entity: InstitutionEntity,
    repo: Repository<InstitutionEntity> = this.institutions,
  ): Promise<InstitutionEntity> {
    try {
      return await repo.save(entity);
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error as QueryFailedError & { code?: string }).code === '23505'
      ) {
        throw new ConflictException('Ya existe una institución con ese NIT');
      }
      throw error;
    }
  }
}
