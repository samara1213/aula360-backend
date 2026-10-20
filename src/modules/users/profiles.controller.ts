import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  PEOPLE_LIST_THROTTLE,
  SENSITIVE_ACTION_THROTTLE,
} from '../../common/constants/throttle';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { AuthUser } from '../../common/interfaces/auth-user.interface';
import { activeInstitutionId } from '../../common/utils/active-institution';
import {
  CreatedStudentResponseDto,
  CreatedTeacherResponseDto,
  StudentPageDto,
  StudentResponseDto,
  TeacherPageDto,
  TeacherResponseDto,
} from './dto/profile-response.dto';
import {
  CreateStudentDto,
  StudentQueryDto,
  UpdateStudentDto,
} from './dto/student.dto';
import {
  CreateTeacherDto,
  TeacherQueryDto,
  UpdateTeacherDto,
} from './dto/teacher.dto';
import { UsersScope } from './managed-users.service';
import { STUDENTS_PERMISSION, StudentsService } from './students.service';
import { TEACHERS_PERMISSION, TeachersService } from './teachers.service';

/** El alcance por sede se calcula con el permiso del perfil, no con security.users. */
const scopeOf = (user: AuthUser, permission: string): UsersScope => ({
  kind: 'institution',
  user,
  institutionId: activeInstitutionId(user),
  permission,
});

const PERSONAL_NOTE =
  'Datos personales con las reglas de PATCH /users/:id (el email solo lo cambia un SUPER_ADMIN; el documento, solo si pertenece únicamente a esta institución). La baja es PATCH /users/:id/status.';

@ApiTags('teachers')
@ApiForbiddenResponse({ description: 'Sin permiso para esta acción' })
@Controller('teachers')
export class TeachersController {
  constructor(private readonly teachers: TeachersService) {}

  @Get()
  @RequirePermission(TEACHERS_PERMISSION, 'view')
  @Throttle(PEOPLE_LIST_THROTTLE)
  @ApiOperation({ summary: 'Listar docentes de la institución activa' })
  @ApiOkResponse({ type: TeacherPageDto })
  findAll(@CurrentUser() user: AuthUser, @Query() query: TeacherQueryDto) {
    return this.teachers.findAll(scopeOf(user, TEACHERS_PERMISSION), query);
  }

  @Get(':id')
  @RequirePermission(TEACHERS_PERMISSION, 'view')
  @ApiOperation({ summary: 'Detalle de un docente' })
  @ApiOkResponse({ type: TeacherResponseDto })
  @ApiNotFoundResponse({ description: 'Docente no encontrado' })
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TeacherResponseDto> {
    return this.teachers.findOne(scopeOf(user, TEACHERS_PERMISSION), id);
  }

  @Post()
  @RequirePermission(TEACHERS_PERMISSION, 'create')
  @Throttle(SENSITIVE_ACTION_THROTTLE)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Crear un docente (usuario, rol TEACHER y perfil)',
    description:
      'La contraseña temporal se devuelve una sola vez (y se envía por correo si hay email).',
  })
  @ApiCreatedResponse({ type: CreatedTeacherResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos o sede inactiva' })
  @ApiNotFoundResponse({ description: 'Sede no encontrada' })
  @ApiConflictResponse({
    description: 'Ya existe un usuario con ese documento o email',
  })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateTeacherDto,
  ): Promise<CreatedTeacherResponseDto> {
    return this.teachers.create(scopeOf(user, TEACHERS_PERMISSION), dto);
  }

  @Patch(':id')
  @RequirePermission(TEACHERS_PERMISSION, 'update')
  @Throttle(SENSITIVE_ACTION_THROTTLE)
  @ApiOperation({
    summary: 'Editar un docente',
    description: PERSONAL_NOTE,
  })
  @ApiOkResponse({ type: TeacherResponseDto })
  @ApiNotFoundResponse({ description: 'Docente no encontrado' })
  @ApiConflictResponse({
    description: 'Ya existe un usuario con ese documento o email',
  })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTeacherDto,
  ): Promise<TeacherResponseDto> {
    return this.teachers.update(scopeOf(user, TEACHERS_PERMISSION), id, dto);
  }
}

@ApiTags('students')
@ApiForbiddenResponse({ description: 'Sin permiso para esta acción' })
@Controller('students')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Get()
  @RequirePermission(STUDENTS_PERMISSION, 'view')
  @Throttle(PEOPLE_LIST_THROTTLE)
  @ApiOperation({
    summary: 'Listar estudiantes de la institución activa',
    description:
      'Sin datos del acudiente ni datos sensibles. Documento y contacto solo de los estudiantes que usted puede editar (y solo entre ellos se busca por documento).',
  })
  @ApiOkResponse({ type: StudentPageDto })
  findAll(@CurrentUser() user: AuthUser, @Query() query: StudentQueryDto) {
    return this.students.findAll(scopeOf(user, STUDENTS_PERMISSION), query);
  }

  @Get(':id')
  @RequirePermission(STUDENTS_PERMISSION, 'view')
  @ApiOperation({
    summary: 'Detalle de un estudiante',
    description:
      'Documento, contacto, acudiente y bloodType solo aparecen si usted puede editar a este estudiante.',
  })
  @ApiOkResponse({ type: StudentResponseDto })
  @ApiNotFoundResponse({ description: 'Estudiante no encontrado' })
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StudentResponseDto> {
    return this.students.findOne(scopeOf(user, STUDENTS_PERMISSION), id);
  }

  @Post()
  @RequirePermission(STUDENTS_PERMISSION, 'create')
  @Throttle(SENSITIVE_ACTION_THROTTLE)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Crear un estudiante (usuario, rol STUDENT en su sede y perfil)',
    description:
      'La contraseña temporal se devuelve una sola vez (y se envía por correo si hay email).',
  })
  @ApiCreatedResponse({ type: CreatedStudentResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos o sede inactiva' })
  @ApiNotFoundResponse({ description: 'Sede no encontrada' })
  @ApiConflictResponse({
    description:
      'Ya existe un usuario con ese documento o email, o un estudiante con ese código',
  })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateStudentDto,
  ): Promise<CreatedStudentResponseDto> {
    return this.students.create(scopeOf(user, STUDENTS_PERMISSION), dto);
  }

  @Patch(':id')
  @RequirePermission(STUDENTS_PERMISSION, 'update')
  @Throttle(SENSITIVE_ACTION_THROTTLE)
  @ApiOperation({
    summary: 'Editar un estudiante (cambiar la sede mueve también su rol)',
    description: `${PERSONAL_NOTE} Cambiar la sede exige además permiso de crear estudiantes en la sede nueva.`,
  })
  @ApiOkResponse({ type: StudentResponseDto })
  @ApiNotFoundResponse({ description: 'Estudiante o sede no encontrado' })
  @ApiConflictResponse({
    description:
      'Documento, email o código de estudiante repetido, o su rol STUDENT no coincide con su sede',
  })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStudentDto,
  ): Promise<StudentResponseDto> {
    return this.students.update(scopeOf(user, STUDENTS_PERMISSION), id, dto);
  }
}
