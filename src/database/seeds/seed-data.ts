/** Datos base del sistema. El seed solo inserta lo que falta; nunca modifica ni borra. */

export interface SeedMenuOption {
  slug: string;
  name: string;
  icon?: string;
  displayOrder: number;
  children?: SeedMenuOption[];
}

/** Menú base (máximo 3 niveles). El slug es la clave de permiso de @RequirePermission. */
export const BASE_MENU: SeedMenuOption[] = [
  {
    slug: 'institution',
    name: 'Institución',
    icon: 'building',
    displayOrder: 1,
    children: [
      {
        slug: 'institution.campuses',
        name: 'Sedes',
        icon: 'map-pin',
        displayOrder: 1,
      },
    ],
  },
  {
    slug: 'security',
    name: 'Seguridad',
    icon: 'shield',
    displayOrder: 2,
    children: [
      { slug: 'security.roles', name: 'Roles', icon: 'key', displayOrder: 1 },
      {
        slug: 'security.menu-options',
        name: 'Menús',
        icon: 'list-tree',
        displayOrder: 2,
      },
      {
        slug: 'security.users',
        name: 'Usuarios',
        icon: 'users',
        displayOrder: 3,
      },
    ],
  },
  {
    slug: 'people',
    name: 'Personas',
    icon: 'contact',
    displayOrder: 3,
    children: [
      {
        slug: 'people.teachers',
        name: 'Docentes',
        icon: 'presentation',
        displayOrder: 1,
      },
      {
        slug: 'people.students',
        name: 'Estudiantes',
        icon: 'graduation-cap',
        displayOrder: 2,
      },
    ],
  },
  {
    slug: 'academic',
    name: 'Académico',
    icon: 'book-open',
    displayOrder: 4,
    children: [
      {
        slug: 'academic.years',
        name: 'Años lectivos',
        icon: 'calendar',
        displayOrder: 1,
      },
      {
        slug: 'academic.periods',
        name: 'Periodos',
        icon: 'calendar-range',
        displayOrder: 2,
      },
      {
        slug: 'academic.grades',
        name: 'Grados',
        icon: 'layers',
        displayOrder: 3,
      },
      {
        slug: 'academic.courses',
        name: 'Cursos',
        icon: 'school',
        displayOrder: 4,
      },
      {
        slug: 'academic.subjects',
        name: 'Materias',
        icon: 'book',
        displayOrder: 5,
      },
      {
        slug: 'academic.teacher-assignments',
        name: 'Carga académica',
        icon: 'clipboard-list',
        displayOrder: 6,
      },
      {
        slug: 'academic.enrollments',
        name: 'Matrículas',
        icon: 'user-plus',
        displayOrder: 7,
      },
    ],
  },
  {
    slug: 'evaluations',
    name: 'Evaluaciones',
    icon: 'clipboard-check',
    displayOrder: 5,
    children: [
      {
        slug: 'evaluations.evaluations',
        name: 'Evaluaciones',
        icon: 'file-check',
        displayOrder: 1,
      },
      {
        slug: 'evaluations.scores',
        name: 'Notas',
        icon: 'pencil',
        displayOrder: 2,
      },
    ],
  },
  {
    slug: 'reports',
    name: 'Reportes',
    icon: 'file-text',
    displayOrder: 6,
    children: [
      {
        slug: 'reports.report-cards',
        name: 'Boletines',
        icon: 'file-down',
        displayOrder: 1,
      },
    ],
  },
];

export interface SeedPermission {
  slug: string;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

const VIEW = { canCreate: false, canUpdate: false, canDelete: false };
const EDIT = { canCreate: true, canUpdate: true, canDelete: false };
const FULL = { canCreate: true, canUpdate: true, canDelete: true };

function allSlugs(options: SeedMenuOption[]): string[] {
  return options.flatMap((o) => [o.slug, ...allSlugs(o.children ?? [])]);
}

export interface SeedRole {
  name: string;
  description: string;
  permissions: SeedPermission[];
}

/** Roles globales (institution_id NULL): se pueden asignar en cualquier institución. */
export const GLOBAL_ROLES: SeedRole[] = [
  {
    name: 'INSTITUTION_ADMIN',
    description:
      'Administrador de institución: gestiona todo dentro de su institución',
    permissions: allSlugs(BASE_MENU).map((slug) => ({ slug, ...FULL })),
  },
  {
    name: 'TEACHER',
    description: 'Docente: sus cursos, evaluaciones y notas',
    permissions: [
      { slug: 'academic', ...VIEW },
      { slug: 'academic.courses', ...VIEW },
      { slug: 'academic.subjects', ...VIEW },
      { slug: 'people', ...VIEW },
      { slug: 'people.students', ...VIEW },
      { slug: 'evaluations', ...VIEW },
      { slug: 'evaluations.evaluations', ...FULL },
      { slug: 'evaluations.scores', ...EDIT },
      { slug: 'reports', ...VIEW },
      { slug: 'reports.report-cards', ...VIEW },
    ],
  },
  {
    name: 'STUDENT',
    description: 'Estudiante: consulta sus notas y boletines',
    permissions: [
      { slug: 'evaluations', ...VIEW },
      { slug: 'evaluations.scores', ...VIEW },
      { slug: 'reports', ...VIEW },
      { slug: 'reports.report-cards', ...VIEW },
    ],
  },
];
