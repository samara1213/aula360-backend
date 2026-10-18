import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { DataSource, EntityManager, Not } from 'typeorm';
import { AuthUser } from '../../common/interfaces/auth-user.interface';
import { sharp } from '../../storage/sharp';
import { StorageService } from '../../storage/storage.service';
import { mapIntegrityError } from '../academic/academic.shared';
import { InstitutionEntity } from '../institutions/entities/institution.entity';
import { DEFAULT_REPORT_CARD_TEMPLATE } from './default-report-card.template';
import {
  CreateReportTemplateDto,
  ReportTemplateResponseDto,
} from './dto/report-template.dto';
import { PerformanceLevelEntity } from './entities/performance-level.entity';
import { ReportCardTemplateEntity } from './entities/report-card-template.entity';
import { PdfRendererService } from './pdf-renderer.service';
import {
  CompiledTemplate,
  compileTemplate,
  ReportCardTemplateData,
  SAMPLE_DATA,
} from './report-template.engine';

const TEMPLATES_BUCKET = 'report-templates';
const LOGO_BUCKET = 'logos';
/** Plantillas compiladas en memoria (clave id:sha256). */
const CACHE_LIMIT = 50;

const sha256 = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** Plantilla lista para usar: null = la plantilla del sistema. */
export interface ResolvedTemplate {
  templateId: string | null;
  render: CompiledTemplate;
}

/**
 * Plantillas de boletín por institución (solo SUPER_ADMIN). El HTML va al
 * bucket privado report-templates y la fila guarda la ruta y su SHA-256, que
 * se verifica al leerlo. No se editan: se sube otra y se activa. Como máximo
 * una activa por institución; sin ninguna se usa la plantilla del sistema.
 * Las acciones quedan en la auditoría (log JSON).
 */
@Injectable()
export class ReportTemplatesService {
  private readonly logger = new Logger(ReportTemplatesService.name);
  private readonly cache = new Map<string, CompiledTemplate>();
  private systemTemplate: CompiledTemplate | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly renderer: PdfRendererService,
  ) {}

  async list(institutionId: string): Promise<ReportTemplateResponseDto[]> {
    await this.institutionOrFail(this.dataSource.manager, institutionId);
    const rows = await this.dataSource.manager
      .getRepository(ReportCardTemplateEntity)
      .find({
        where: { institutionId },
        order: { createdAt: 'DESC', id: 'ASC' },
      });
    return rows.map((row) => ReportTemplateResponseDto.from(row));
  }

  async create(
    user: AuthUser,
    institutionId: string,
    dto: CreateReportTemplateDto,
    source: string,
  ): Promise<ReportTemplateResponseDto> {
    const manager = this.dataSource.manager;
    await this.institutionOrFail(manager, institutionId);
    compileTemplate(source); // 400 si no sirve
    const contentSha256 = sha256(source);
    const repo = manager.getRepository(ReportCardTemplateEntity);
    if (await repo.existsBy({ institutionId, contentSha256 })) {
      throw new ConflictException(
        'La institución ya tiene una plantilla con ese mismo contenido',
      );
    }
    const storagePath = await this.storage.upload(
      TEMPLATES_BUCKET,
      `${institutionId}/report-templates`,
      {
        buffer: Buffer.from(source, 'utf8'),
        mimeType: 'text/html',
        extension: 'html',
      },
    );
    let saved: ReportCardTemplateEntity;
    try {
      saved = await repo.save(
        repo.create({
          institutionId,
          name: dto.name,
          description: dto.description || null,
          storagePath,
          contentSha256,
          isActive: false,
          createdBy: user.userId,
        }),
      );
    } catch (error) {
      await this.storage.removeQuietly(TEMPLATES_BUCKET, storagePath);
      // Dos subidas iguales a la vez: la segunda choca con el UNIQUE (B4).
      throw mapIntegrityError(error, {
        duplicate:
          'La institución ya tiene una plantilla con ese mismo contenido',
      });
    }
    this.audit(user, 'report-template.created', saved);
    return ReportTemplateResponseDto.from(saved);
  }

  /** Activa esta y desactiva la que estuviera activa (una por institución). */
  async activate(
    user: AuthUser,
    institutionId: string,
    id: string,
  ): Promise<ReportTemplateResponseDto> {
    // Fuera de la transacción: leerla de Storage y compilarla puede tardar y
    // no debe hacerse con bloqueos tomados (hallazgo M5 de la fase 10a).
    await this.institutionOrFail(this.dataSource.manager, institutionId);
    await this.compiled(
      await this.templateOrFail(this.dataSource.manager, institutionId, id),
    );
    const { row, previousId } = await this.dataSource.transaction(
      async (manager) => {
        await this.lockTemplates(manager, institutionId);
        const template = await this.templateOrFail(manager, institutionId, id);
        const repo = manager.getRepository(ReportCardTemplateEntity);
        const previous = await repo.findOneBy({
          institutionId,
          isActive: true,
          id: Not(id),
        });
        if (previous) {
          await repo.update({ id: previous.id }, { isActive: false });
        }
        template.isActive = true;
        return {
          row: await repo.save(template),
          previousId: previous?.id ?? null,
        };
      },
    );
    this.audit(user, 'report-template.activated', row, {
      previousTemplateId: previousId,
    });
    return ReportTemplateResponseDto.from(row);
  }

  /** La institución vuelve a la plantilla del sistema. */
  async deactivate(
    user: AuthUser,
    institutionId: string,
    id: string,
  ): Promise<ReportTemplateResponseDto> {
    const row = await this.dataSource.transaction(async (manager) => {
      await this.lockTemplates(manager, institutionId);
      const template = await this.templateOrFail(manager, institutionId, id);
      template.isActive = false;
      return manager.getRepository(ReportCardTemplateEntity).save(template);
    });
    this.audit(user, 'report-template.deactivated', row);
    return ReportTemplateResponseDto.from(row);
  }

  /** Solo si ningún boletín la usó (409); el archivo se borra después. */
  async remove(
    user: AuthUser,
    institutionId: string,
    id: string,
  ): Promise<void> {
    const row = await this.dataSource.transaction(async (manager) => {
      await this.lockTemplates(manager, institutionId);
      const template = await this.templateOrFail(manager, institutionId, id);
      try {
        await manager
          .getRepository(ReportCardTemplateEntity)
          .delete({ id: template.id });
      } catch (error) {
        throw mapIntegrityError(error, {
          duplicate: 'Conflicto al borrar la plantilla',
          inUse:
            'La plantilla ya se usó en boletines: desactívela en lugar de borrarla',
        });
      }
      return template;
    });
    this.cache.delete(`${row.id}:${row.contentSha256}`);
    await this.storage.removeQuietly(TEMPLATES_BUCKET, row.storagePath);
    this.audit(user, 'report-template.deleted', row);
  }

  /**
   * Vista previa con datos de ejemplo (nunca de un estudiante real), con el
   * nombre, el logo, la escala y los niveles de la institución.
   * id null = la plantilla del sistema.
   */
  async preview(institutionId: string, id: string | null): Promise<Buffer> {
    const manager = this.dataSource.manager;
    const institution = await this.institutionOrFail(manager, institutionId);
    const render = id
      ? await this.compiled(
          await this.templateOrFail(manager, institutionId, id),
        )
      : this.system();
    const levels = await manager.getRepository(PerformanceLevelEntity).find({
      where: { institutionId },
      order: { minScore: 'ASC' },
    });
    const data: ReportCardTemplateData = {
      ...SAMPLE_DATA,
      institution: {
        name: institution.name,
        nit: institution.nit,
        logoDataUri: await this.logoDataUri(institution),
      },
      scale: {
        min: institution.gradingScaleMin,
        max: institution.gradingScaleMax,
        passingScore: institution.passingScore,
      },
      levels: levels.length
        ? levels.map((l) => ({
            name: l.name,
            minScore: l.minScore,
            maxScore: l.maxScore,
          }))
        : SAMPLE_DATA.levels,
    };
    return this.renderer.render(render(data));
  }

  /** Plantilla activa de la institución, o la del sistema (para generar). */
  async resolveActive(
    manager: EntityManager,
    institutionId: string,
  ): Promise<ResolvedTemplate> {
    const active = await manager
      .getRepository(ReportCardTemplateEntity)
      .findOneBy({ institutionId, isActive: true });
    return active
      ? { templateId: active.id, render: await this.compiled(active) }
      : { templateId: null, render: this.system() };
  }

  /** Logo como data URI PNG (el renderizador no hace peticiones); null si falla. */
  async logoDataUri(institution: InstitutionEntity): Promise<string | null> {
    if (!institution.logoPath) return null;
    try {
      const original = await this.storage.download(
        LOGO_BUCKET,
        institution.logoPath,
      );
      const png = await sharp(original).png().toBuffer();
      return `data:image/png;base64,${png.toString('base64')}`;
    } catch (error) {
      this.logger.warn(
        `Boletín sin logo (${institution.id}): ${(error as Error).message}`,
      );
      return null;
    }
  }

  private system(): CompiledTemplate {
    this.systemTemplate ??= compileTemplate(DEFAULT_REPORT_CARD_TEMPLATE);
    return this.systemTemplate;
  }

  /** Lee el HTML, verifica su SHA-256 y lo compila (con caché). */
  private async compiled(
    template: ReportCardTemplateEntity,
  ): Promise<CompiledTemplate> {
    const key = `${template.id}:${template.contentSha256}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const source = (
      await this.storage.download(TEMPLATES_BUCKET, template.storagePath)
    ).toString('utf8');
    if (sha256(source) !== template.contentSha256) {
      this.logger.error(
        `La plantilla ${template.id} no coincide con su SHA-256: no se usa`,
      );
      throw new BadGatewayException('La plantilla está dañada');
    }
    const render = compileTemplate(source);
    if (this.cache.size >= CACHE_LIMIT) {
      this.cache.delete(this.cache.keys().next().value as string);
    }
    this.cache.set(key, render);
    return render;
  }

  private async institutionOrFail(
    manager: EntityManager,
    id: string,
  ): Promise<InstitutionEntity> {
    const institution = await manager
      .getRepository(InstitutionEntity)
      .findOneBy({ id });
    if (!institution) throw new NotFoundException('Institución no encontrada');
    return institution;
  }

  /**
   * Serializa activar, desactivar y borrar plantillas de una institución con
   * un bloqueo propio (no la fila de la institución, que bloquearía el
   * registro de notas; hallazgo M5 de la fase 10a).
   */
  private async lockTemplates(
    manager: EntityManager,
    institutionId: string,
  ): Promise<void> {
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`report-templates:${institutionId}`],
    );
  }

  private async templateOrFail(
    manager: EntityManager,
    institutionId: string,
    id: string,
  ): Promise<ReportCardTemplateEntity> {
    const template = await manager
      .getRepository(ReportCardTemplateEntity)
      .findOneBy({ id, institutionId });
    if (!template) throw new NotFoundException('Plantilla no encontrada');
    return template;
  }

  private audit(
    user: AuthUser,
    action: string,
    template: ReportCardTemplateEntity,
    details: Record<string, unknown> = {},
  ): void {
    this.logger.log(
      JSON.stringify({
        audit: action,
        actorId: user.userId,
        institutionId: template.institutionId,
        templateId: template.id,
        contentSha256: template.contentSha256,
        ...details,
      }),
    );
  }
}
