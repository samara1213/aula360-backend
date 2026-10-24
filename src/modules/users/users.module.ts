import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { SecurityModule } from '../security/security.module';
import { UserEntity } from './entities/user.entity';
import { MyInvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { LookupBudget } from './lookup-budget';
import {
  InstitutionUsersController,
  ManagedUsersController,
} from './managed-users.controller';
import { ManagedUsersService } from './managed-users.service';
import { StudentsController, TeachersController } from './profiles.controller';
import { StudentsService } from './students.service';
import { TeachersService } from './teachers.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity]),
    SecurityModule,
    MailModule,
    AuthModule,
  ],
  // UsersController (rutas /users/me/...) va primero: sus rutas fijas deben
  // registrarse antes que las de /users/:id.
  controllers: [
    UsersController,
    MyInvitationsController,
    ManagedUsersController,
    InstitutionUsersController,
    TeachersController,
    StudentsController,
  ],
  providers: [
    UsersService,
    ManagedUsersService,
    TeachersService,
    StudentsService,
    InvitationsService,
    LookupBudget,
  ],
})
export class UsersModule {}
