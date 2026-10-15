import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ValidatedFile } from '../../storage/image-file.pipe';
import { SIGNED_URL_TTL_SECONDS } from '../../storage/storage.constants';
import { StorageService } from '../../storage/storage.service';
import { AvatarResponseDto } from './dto/avatar-response.dto';
import { UserEntity } from './entities/user.entity';

const AVATAR_BUCKET = 'avatars';

/**
 * Usuarios. Por ahora solo el avatar propio (fase 6); el CRUD por
 * administradores llega en la fase 7.
 *
 * El avatar es del usuario, no de una institución (puede estar en varias o,
 * si es SUPER_ADMIN, en ninguna): ruta `users/<userId>/<uuid>.<ext>` en el
 * bucket privado `avatars`, servido con URL firmada.
 */
@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
  ) {}

  async getAvatar(userId: string): Promise<AvatarResponseDto> {
    const user = await this.users.findOne({
      select: { id: true, avatarPath: true },
      where: { id: userId },
    });
    if (!user?.avatarPath) {
      throw new NotFoundException('El usuario no tiene avatar');
    }
    return this.toAvatar(user.avatarPath);
  }

  /**
   * Sube el avatar nuevo, guarda su ruta con la fila bloqueada y después borra
   * el anterior. Si falla la BD, se borra el recién subido.
   */
  async replaceAvatar(
    userId: string,
    file: ValidatedFile,
  ): Promise<AvatarResponseDto> {
    const path = await this.storage.upload(
      AVATAR_BUCKET,
      `users/${userId}`,
      file,
    );
    try {
      await this.setAvatarPath(userId, path);
    } catch (error) {
      await this.storage.removeQuietly(AVATAR_BUCKET, path);
      throw error;
    }
    return this.toAvatar(path);
  }

  async removeAvatar(userId: string): Promise<void> {
    await this.setAvatarPath(userId, null);
  }

  private async setAvatarPath(
    userId: string,
    path: string | null,
  ): Promise<void> {
    const previous = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(UserEntity);
      const user = await repo.findOne({
        select: { id: true, avatarPath: true },
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user) throw new NotFoundException('Usuario no encontrado');
      if (user.avatarPath !== path) {
        await repo.update({ id: userId }, { avatarPath: path });
      }
      return user.avatarPath;
    });
    if (previous && previous !== path) {
      await this.storage.removeQuietly(AVATAR_BUCKET, previous);
    }
  }

  private async toAvatar(path: string): Promise<AvatarResponseDto> {
    return {
      avatarPath: path,
      url: await this.storage.createSignedUrl(AVATAR_BUCKET, path),
      expiresIn: SIGNED_URL_TTL_SECONDS,
    };
  }
}
