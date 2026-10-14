import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Esquema inicial de Aula360: copia literal de scrip_base_datos_v2.sql
 * (tablas, CHECK, índices parciales y Row Level Security).
 * Se ejecuta con el rol "postgres" de Supabase.
 */
export class InitialSchema1791933998562 implements MigrationInterface {
  name = 'InitialSchema1791933998562';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "citext";   -- [v2] email sin distinguir mayúsculas

--------------------------------------------------------------------------------
-- 1. MÓDULO ORGANIZACIONAL E IDENTIDAD
--------------------------------------------------------------------------------

CREATE TABLE institutions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    nit VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    logo_path VARCHAR(500),                                   -- [v2] ruta en Storage (antes logo_url)
    grading_scale_min DECIMAL(4,2) NOT NULL DEFAULT 1.00,     -- [v2] escala de notas de la institución
    grading_scale_max DECIMAL(4,2) NOT NULL DEFAULT 5.00,     -- [v2] (ajusta los valores por defecto)
    passing_score DECIMAL(4,2) NOT NULL DEFAULT 3.00,         -- [v2] nota mínima aprobatoria
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_institutions_scale CHECK (
        grading_scale_min < grading_scale_max
        AND passing_score BETWEEN grading_scale_min AND grading_scale_max
    )
);

CREATE TABLE campuses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,  -- [v2] RESTRICT
    name VARCHAR(255) NOT NULL,
    address VARCHAR(255),
    city VARCHAR(100),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,                  -- [v2] desactivación lógica
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,   -- [v2]
    UNIQUE (institution_id, name)                             -- [v2]
);

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_type VARCHAR(50) NOT NULL CHECK (user_type IN ('SUPER_ADMIN', 'INSTITUTION_ADMIN', 'TEACHER', 'STUDENT')),
    document_type VARCHAR(20) NOT NULL,
    document_number VARCHAR(50) NOT NULL,                     -- [v2] la unicidad pasa a (tipo, número)
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email CITEXT UNIQUE,                                      -- [v2] opcional (muchos estudiantes no tienen) y sin distinguir mayúsculas
    password_hash VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    avatar_path VARCHAR(500),                                 -- [v2] ruta en Storage (antes avatar_url)
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,      -- [v2] contraseña temporal creada por un admin
    last_login_at TIMESTAMP WITH TIME ZONE,                   -- [v2]
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_users_document UNIQUE (document_type, document_number)     -- [v2]
);

CREATE TABLE teachers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    academic_degree VARCHAR(150),
    specialty VARCHAR(150),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, institution_id)                          -- [v2] un docente puede trabajar en varias instituciones
);

CREATE TABLE students (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    campus_id UUID REFERENCES campuses(id) ON DELETE SET NULL,
    student_code VARCHAR(50),
    guardian_name VARCHAR(150),
    guardian_phone VARCHAR(50),
    guardian_email VARCHAR(255),
    blood_type VARCHAR(10),   -- dato sensible de menores: acceso restringido y consentimiento (Ley 1581 de 2012)
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, institution_id),                         -- [v2]
    UNIQUE (institution_id, student_code)                     -- [v2] código único por institución
);

--------------------------------------------------------------------------------
-- 2. MÓDULO DE SEGURIDAD Y MENÚS JERÁRQUICOS (CORE)
--------------------------------------------------------------------------------

CREATE TABLE menu_options (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    parent_id UUID REFERENCES menu_options(id) ON DELETE CASCADE, -- Jerarquía Padre -> Hijo -> Nieto (máx. 3 niveles: se valida en el service)
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(255) NOT NULL UNIQUE,                        -- [v2] único: se usa como clave de permiso
    icon VARCHAR(100),
    display_order INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_menu_not_self_parent CHECK (parent_id IS NULL OR parent_id <> id)  -- [v2]
);

CREATE TABLE roles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID REFERENCES institutions(id) ON DELETE RESTRICT, -- NULL si es un rol global del sistema
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- [v2] UNIQUE normal no sirve con NULL: dos índices parciales
CREATE UNIQUE INDEX uq_roles_institution_name ON roles (institution_id, name) WHERE institution_id IS NOT NULL;
CREATE UNIQUE INDEX uq_roles_global_name ON roles (name) WHERE institution_id IS NULL;

CREATE TABLE role_menu_permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    menu_option_id UUID NOT NULL REFERENCES menu_options(id) ON DELETE CASCADE,
    can_create BOOLEAN NOT NULL DEFAULT FALSE,                -- [v2] la fila existente implica "ver"
    can_update BOOLEAN NOT NULL DEFAULT FALSE,                -- [v2]
    can_delete BOOLEAN NOT NULL DEFAULT FALSE,                -- [v2]
    UNIQUE (role_id, menu_option_id)
);

CREATE TABLE user_institution_roles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    -- [v2] RESTRICT: con SET NULL, borrar una sede convertiría un rol de sede en rol de toda la institución
    campus_id UUID REFERENCES campuses(id) ON DELETE RESTRICT,
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- [v2] evitar asignaciones duplicadas (campus NULL requiere índice aparte)
CREATE UNIQUE INDEX uq_uir_with_campus ON user_institution_roles (user_id, institution_id, role_id, campus_id) WHERE campus_id IS NOT NULL;
CREATE UNIQUE INDEX uq_uir_without_campus ON user_institution_roles (user_id, institution_id, role_id) WHERE campus_id IS NULL;

-- [v2] Refresh tokens (guardar solo el hash; permite rotación y revocación)
CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- [v2] Tokens de recuperación de contraseña (solo el hash, un solo uso, con expiración)
CREATE TABLE password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

--------------------------------------------------------------------------------
-- 3. MÓDULO ACADÉMICO
-- [v2] Los registros académicos usan ON DELETE RESTRICT: no se borran en cascada,
--      se desactivan o se bloquea el borrado.
--------------------------------------------------------------------------------

CREATE TABLE academic_years (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    year INT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (institution_id, year)
);

CREATE TABLE periods (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    academic_year_id UUID NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
    name VARCHAR(100) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_periods_dates CHECK (end_date >= start_date),   -- [v2]
    UNIQUE (academic_year_id, name)                                -- [v2]
);

CREATE TABLE grades (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (institution_id, name)                                  -- [v2]
);

CREATE TABLE courses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    grade_id UUID NOT NULL REFERENCES grades(id) ON DELETE RESTRICT,
    campus_id UUID NOT NULL REFERENCES campuses(id) ON DELETE RESTRICT,
    academic_year_id UUID NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (grade_id, campus_id, academic_year_id, name)           -- [v2]
);

CREATE TABLE subjects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE RESTRICT,
    name VARCHAR(150) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (institution_id, name)                                  -- [v2]
);

CREATE TABLE teacher_subject_courses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
    subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
    teacher_id UUID NOT NULL REFERENCES teachers(id) ON DELETE RESTRICT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,                  -- [v2] FALSE cuando el docente es reemplazado (se conserva el historial)
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deactivated_at TIMESTAMP WITH TIME ZONE                   -- [v2] fecha del reemplazo
);
-- [v2] Un solo docente ACTIVO por materia y curso. Los docentes reemplazados quedan como historial
-- y las evaluaciones que crearon siguen ligadas a su asignación.
CREATE UNIQUE INDEX uq_tsc_active_course_subject ON teacher_subject_courses (course_id, subject_id) WHERE is_active;

CREATE TABLE enrollments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
    academic_year_id UUID NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT, -- debe coincidir con courses.academic_year_id (se valida en el service)
    enrollment_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(50) NOT NULL DEFAULT 'ENROLLED' CHECK (status IN ('ENROLLED', 'DROPPED', 'GRADUATED', 'SUSPENDED')),
    observations TEXT,
    UNIQUE (student_id, academic_year_id)
);

--------------------------------------------------------------------------------
-- 4. MÓDULO DE EVALUACIONES, CALIFICACIONES Y REPORTES
--------------------------------------------------------------------------------

CREATE TABLE evaluations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    teacher_subject_course_id UUID NOT NULL REFERENCES teacher_subject_courses(id) ON DELETE RESTRICT,
    period_id UUID NOT NULL REFERENCES periods(id) ON DELETE RESTRICT,
    title VARCHAR(200) NOT NULL,
    percentage DECIMAL(5,2) NOT NULL, -- Ej: 20.00 para representar el 20%. La suma por materia/curso/periodo se valida en el service
    evaluation_date DATE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_evaluations_percentage CHECK (percentage > 0 AND percentage <= 100)  -- [v2]
);

CREATE TABLE scores (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    evaluation_id UUID NOT NULL REFERENCES evaluations(id) ON DELETE RESTRICT,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
    score DECIMAL(5,2) NOT NULL,      -- el rango se valida en el service con la escala de la institución
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,   -- [v2] quién registró/cambió la nota
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_scores_non_negative CHECK (score >= 0),     -- [v2]
    UNIQUE (evaluation_id, student_id)
);

CREATE TABLE report_cards (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
    period_id UUID NOT NULL REFERENCES periods(id) ON DELETE RESTRICT,
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
    final_average DECIMAL(5,2) NOT NULL,
    pdf_path VARCHAR(500),            -- [v2] ruta en Supabase Storage (antes pdf_url); se accede con URL firmada
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- [v2] regeneraciones
    CONSTRAINT chk_report_cards_average CHECK (final_average >= 0),          -- [v2]
    UNIQUE (student_id, period_id)
);

--------------------------------------------------------------------------------
-- 5. ÍNDICES DE RENDIMIENTO
-- [v2] Postgres no indexa las FKs automáticamente. Se eliminaron idx_users_email
--      e idx_enrollments_student porque los UNIQUE ya los cubren.
--------------------------------------------------------------------------------
CREATE INDEX idx_users_document_number ON users(document_number);
CREATE INDEX idx_campuses_institution ON campuses(institution_id);
CREATE INDEX idx_teachers_institution ON teachers(institution_id);
CREATE INDEX idx_students_institution ON students(institution_id);
CREATE INDEX idx_students_campus ON students(campus_id);
CREATE INDEX idx_menu_options_parent ON menu_options(parent_id);
CREATE INDEX idx_roles_institution ON roles(institution_id);
CREATE INDEX idx_rmp_menu_option ON role_menu_permissions(menu_option_id);
CREATE INDEX idx_uir_user ON user_institution_roles(user_id);
CREATE INDEX idx_uir_institution ON user_institution_roles(institution_id);
CREATE INDEX idx_uir_role ON user_institution_roles(role_id);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_password_reset_tokens_user ON password_reset_tokens(user_id);
CREATE INDEX idx_courses_campus ON courses(campus_id);
CREATE INDEX idx_courses_year ON courses(academic_year_id);
CREATE INDEX idx_tsc_course ON teacher_subject_courses(course_id);
CREATE INDEX idx_tsc_subject ON teacher_subject_courses(subject_id);
CREATE INDEX idx_tsc_teacher ON teacher_subject_courses(teacher_id);
CREATE INDEX idx_enrollments_course ON enrollments(course_id);
CREATE INDEX idx_evaluations_tsc ON evaluations(teacher_subject_course_id);
CREATE INDEX idx_evaluations_period ON evaluations(period_id);
CREATE INDEX idx_scores_student ON scores(student_id);
CREATE INDEX idx_report_cards_period_course ON report_cards(period_id, course_id);

--------------------------------------------------------------------------------
-- 6. [v2] SEGURIDAD EN SUPABASE: ROW LEVEL SECURITY
-- Supabase expone el esquema "public" por su API REST con la clave anon.
-- Sin RLS, cualquiera con esa clave podría leer y modificar estas tablas.
-- Se activa RLS sin políticas (deniega todo a anon/authenticated). El backend
-- NestJS conecta con el rol "postgres", que se salta RLS, y no se ve afectado.
--------------------------------------------------------------------------------
DO $$
DECLARE t RECORD;
BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    END LOOP;
END $$;
`);
  }

  /**
   * Elimina todas las tablas en orden inverso a las dependencias.
   * DESTRUCTIVO: solo para desarrollo. Las extensiones uuid-ossp y citext se conservan.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "report_cards"');
    await queryRunner.query('DROP TABLE IF EXISTS "scores"');
    await queryRunner.query('DROP TABLE IF EXISTS "evaluations"');
    await queryRunner.query('DROP TABLE IF EXISTS "enrollments"');
    await queryRunner.query('DROP TABLE IF EXISTS "teacher_subject_courses"');
    await queryRunner.query('DROP TABLE IF EXISTS "subjects"');
    await queryRunner.query('DROP TABLE IF EXISTS "courses"');
    await queryRunner.query('DROP TABLE IF EXISTS "grades"');
    await queryRunner.query('DROP TABLE IF EXISTS "periods"');
    await queryRunner.query('DROP TABLE IF EXISTS "academic_years"');
    await queryRunner.query('DROP TABLE IF EXISTS "password_reset_tokens"');
    await queryRunner.query('DROP TABLE IF EXISTS "refresh_tokens"');
    await queryRunner.query('DROP TABLE IF EXISTS "user_institution_roles"');
    await queryRunner.query('DROP TABLE IF EXISTS "role_menu_permissions"');
    await queryRunner.query('DROP TABLE IF EXISTS "roles"');
    await queryRunner.query('DROP TABLE IF EXISTS "menu_options"');
    await queryRunner.query('DROP TABLE IF EXISTS "students"');
    await queryRunner.query('DROP TABLE IF EXISTS "teachers"');
    await queryRunner.query('DROP TABLE IF EXISTS "users"');
    await queryRunner.query('DROP TABLE IF EXISTS "campuses"');
    await queryRunner.query('DROP TABLE IF EXISTS "institutions"');
  }
}
