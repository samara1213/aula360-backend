import { AcademicYearEntity } from '../modules/academic/entities/academic-year.entity';
import { CourseEntity } from '../modules/academic/entities/course.entity';
import { GradeEntity } from '../modules/academic/entities/grade.entity';
import { PeriodEntity } from '../modules/academic/entities/period.entity';
import { SubjectEntity } from '../modules/academic/entities/subject.entity';
import { TeacherSubjectCourseEntity } from '../modules/academic/entities/teacher-subject-course.entity';
import { EmailVerificationTokenEntity } from '../modules/auth/entities/email-verification-token.entity';
import { PasswordResetTokenEntity } from '../modules/auth/entities/password-reset-token.entity';
import { RefreshTokenEntity } from '../modules/auth/entities/refresh-token.entity';
import { EnrollmentEntity } from '../modules/enrollments/entities/enrollment.entity';
import { EvaluationEntity } from '../modules/evaluations/entities/evaluation.entity';
import { ScoreEntity } from '../modules/evaluations/entities/score.entity';
import { CampusEntity } from '../modules/institutions/entities/campus.entity';
import { InstitutionEntity } from '../modules/institutions/entities/institution.entity';
import { PerformanceLevelEntity } from '../modules/reports/entities/performance-level.entity';
import { ReportCardTemplateEntity } from '../modules/reports/entities/report-card-template.entity';
import { ReportCardEntity } from '../modules/reports/entities/report-card.entity';
import { MenuOptionEntity } from '../modules/security/entities/menu-option.entity';
import { RoleMenuPermissionEntity } from '../modules/security/entities/role-menu-permission.entity';
import { RoleEntity } from '../modules/security/entities/role.entity';
import { UserInstitutionRoleEntity } from '../modules/security/entities/user-institution-role.entity';
import { InstitutionInvitationEntity } from '../modules/users/entities/institution-invitation.entity';
import { StudentEntity } from '../modules/users/entities/student.entity';
import { TeacherEntity } from '../modules/users/entities/teacher.entity';
import { UserEntity } from '../modules/users/entities/user.entity';
import { StorageDeletionEntity } from '../storage/entities/storage-deletion.entity';

/** Todas las entidades del esquema (scrip_base_datos_v2.sql y migraciones posteriores). */
export const ALL_ENTITIES = [
  InstitutionEntity,
  CampusEntity,
  UserEntity,
  TeacherEntity,
  StudentEntity,
  MenuOptionEntity,
  RoleEntity,
  RoleMenuPermissionEntity,
  UserInstitutionRoleEntity,
  RefreshTokenEntity,
  PasswordResetTokenEntity,
  AcademicYearEntity,
  PeriodEntity,
  GradeEntity,
  CourseEntity,
  SubjectEntity,
  TeacherSubjectCourseEntity,
  EnrollmentEntity,
  EvaluationEntity,
  ScoreEntity,
  ReportCardEntity,
  PerformanceLevelEntity,
  ReportCardTemplateEntity,
  StorageDeletionEntity,
  EmailVerificationTokenEntity,
  InstitutionInvitationEntity,
];
