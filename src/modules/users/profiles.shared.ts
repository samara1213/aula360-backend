import { InternalServerErrorException } from '@nestjs/common';
import { EntityManager, IsNull } from 'typeorm';
import { RoleEntity } from '../security/entities/role.entity';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserEntity } from './entities/user.entity';

/** Id del rol global del seed (TEACHER o STUDENT) con que se crean los perfiles. */
export async function globalRoleId(
  manager: EntityManager,
  name: 'TEACHER' | 'STUDENT',
): Promise<string> {
  const role = await manager.getRepository(RoleEntity).findOne({
    select: { id: true },
    where: { name, institutionId: IsNull() },
  });
  if (!role) {
    // Solo pasa si falta el seed: es un error de configuración, no del cliente.
    throw new InternalServerErrorException(`Falta el rol global ${name}`);
  }
  return role.id;
}

/** Datos personales de un DTO de perfil (se aplican con las reglas de usuarios). */
export function personalFields(dto: UpdateUserDto): UpdateUserDto {
  const { documentType, documentNumber, firstName, lastName, email, phone } =
    dto;
  return { documentType, documentNumber, firstName, lastName, email, phone };
}

/** SELECT ... FOR UPDATE del usuario del perfil: se serializa con la gestión de usuarios. */
export function lockUser(
  manager: EntityManager,
  userId: string,
): Promise<UserEntity> {
  return manager.getRepository(UserEntity).findOneOrFail({
    where: { id: userId },
    lock: { mode: 'pessimistic_write' },
  });
}

/** Copia al objeto de cambios solo los campos presentes en el DTO. */
export function pickDefined<T extends object, K extends keyof T>(
  dto: T,
  keys: readonly K[],
): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (dto[key] !== undefined) out[key] = dto[key];
  }
  return out;
}
