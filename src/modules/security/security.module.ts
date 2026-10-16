import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CampusEntity } from '../institutions/entities/campus.entity';
import { InstitutionEntity } from '../institutions/entities/institution.entity';
import { UserEntity } from '../users/entities/user.entity';
import { MenuOptionEntity } from './entities/menu-option.entity';
import { RoleMenuPermissionEntity } from './entities/role-menu-permission.entity';
import { RoleEntity } from './entities/role.entity';
import { UserInstitutionRoleEntity } from './entities/user-institution-role.entity';
import { GlobalRolesController } from './global-roles.controller';
import { MenuOptionsController } from './menu-options.controller';
import { MenuOptionsService } from './menu-options.service';
import { PermissionsReader } from './permissions-reader.service';
import {
  InstitutionRoleAssignmentsController,
  RoleAssignmentsController,
} from './role-assignments.controller';
import { RoleAssignmentsService } from './role-assignments.service';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MenuOptionEntity,
      RoleEntity,
      RoleMenuPermissionEntity,
      UserInstitutionRoleEntity,
      UserEntity,
      CampusEntity,
      InstitutionEntity,
    ]),
  ],
  controllers: [
    MenuOptionsController,
    RolesController,
    GlobalRolesController,
    RoleAssignmentsController,
    InstitutionRoleAssignmentsController,
  ],
  providers: [
    PermissionsReader,
    MenuOptionsService,
    RolesService,
    RoleAssignmentsService,
  ],
  exports: [PermissionsReader, RoleAssignmentsService],
})
export class SecurityModule {}
