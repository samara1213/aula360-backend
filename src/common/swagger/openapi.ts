import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { enrichDocument, SESSION_SCHEME } from './enrich-document';
import { ErrorResponseDto } from './error-response.dto';

const DESCRIPTION = `
API del backend de Aula360: gestión de instituciones educativas (multi-institución).

## Sesión
- \`POST /api/auth/login\` fija dos cookies httpOnly (SameSite=Lax). El cliente no las lee ni las envía a mano: basta con \`credentials: 'include'\` (fetch) o \`withCredentials: true\` (axios).
  - Access token (15 min por defecto): \`access_token\`; en producción \`__Host-access_token\`.
  - Refresh token: \`refresh_token\` (path \`/api/auth\`); en producción \`__Secure-refresh_token\`.
- Ante un **401**, llamar a \`POST /api/auth/refresh-token\` (rota el refresh token) y repetir la petición; si también responde 401, volver al login.
- **Una sola renovación a la vez:** las peticiones que reciban 401 mientras hay un refresh en curso deben esperarlo y no lanzar otro. Reenviar un refresh token ya usado se trata como robo y **cierra todas las sesiones** del usuario.
- Con contraseña temporal, las rutas con sesión responden **403** «Debe cambiar la contraseña», salvo \`GET /api/auth/me\` y \`POST /api/auth/change-password\`. Las rutas públicas (incluido \`POST /api/auth/logout\`) siguen disponibles.

## Institución activa
- Todos los datos se filtran por la institución activa de la sesión; la API nunca acepta un \`institutionId\` del cliente para elegirla. Las únicas rutas con \`{institutionId}\` están bajo \`/api/institutions/{institutionId}/…\` y son solo del SUPER_ADMIN.
- Con varias instituciones, el login deja \`activeInstitutionId\` en null y se elige con \`POST /api/auth/switch-institution\`.
- Un id de otra institución responde **404**, igual que uno inexistente.

## Protección CSRF
Los métodos que modifican datos (POST, PUT, PATCH, DELETE) con cabecera \`Origin\` (o \`Referer\`) de un origen que no está entre los orígenes permitidos responden **403** «Origen no permitido». Esta página solo existe fuera de producción; para probar desde ella, su origen debe estar permitido en el entorno local. En producción solo se permiten los orígenes del frontend.

## Errores
Todos los errores tienen el cuerpo \`ErrorResponseDto\`: \`{ statusCode, message, error, path, timestamp }\`. En validación (400) \`message\` es la lista de errores; los campos no declarados se rechazan («property X should not exist»). Un **409** indica un dato duplicado o relacionado (no se reintenta) o un conflicto de concurrencia, «Conflicto de concurrencia, intente de nuevo» (se puede reintentar).

## Listados
Paginación con \`page\` (desde 1) y \`limit\` (1 a 100, por defecto 20). La respuesta es \`{ data, meta: { page, limit, total, totalPages } }\`.

## Límites de peticiones
Límite global de 100 peticiones por minuto por IP. Algunas rutas lo reemplazan por uno propio, a veces contado por usuario (login y recuperación de contraseña, subidas, listados de personas, notas, boletines). Al superarlo: **429** con cabecera \`Retry-After\`.
`.trim();

const TAGS: [string, string][] = [
  ['auth', 'Login, sesión, cambio de institución y recuperación de contraseña'],
  ['users', 'Perfil propio y gestión de usuarios de la institución'],
  ['institutions', 'Instituciones (SUPER_ADMIN) e institución activa'],
  ['campuses', 'Sedes de la institución activa'],
  ['roles', 'Roles de la institución y sus permisos por opción de menú'],
  ['global-roles', 'Roles globales del sistema (SUPER_ADMIN)'],
  [
    'role-assignments',
    'Asignación de roles a usuarios (por institución o sede)',
  ],
  ['menu-options', 'Árbol de menús global'],
  ['teachers', 'Docentes'],
  ['students', 'Estudiantes'],
  ['academic-years', 'Años lectivos'],
  ['periods', 'Periodos académicos'],
  ['grades', 'Grados'],
  ['subjects', 'Asignaturas'],
  ['courses', 'Cursos'],
  ['teacher-assignments', 'Cargas docentes (docente, asignatura y curso)'],
  ['enrollments', 'Matrículas'],
  ['evaluations', 'Evaluaciones y registro de notas'],
  ['gradebook', 'Planillas de notas y promedios'],
  ['performance-levels', 'Niveles de desempeño de la institución'],
  [
    'report-card-templates',
    'Plantillas de boletín por institución (SUPER_ADMIN)',
  ],
  ['report-cards', 'Boletines en PDF'],
  ['health', 'Estado de la API'],
  [
    'csp-reports',
    'Violaciones de la CSP que informa el navegador (sin sesión)',
  ],
];

/** Documento OpenAPI completo (lo usan /api/docs y `yarn openapi:export`). */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const builder = new DocumentBuilder()
    .setTitle('Aula360 API')
    .setDescription(DESCRIPTION)
    .setVersion('1.0')
    .addCookieAuth(
      'access_token',
      {
        type: 'apiKey',
        in: 'cookie',
        description:
          'La fija el login. En producción se llama __Host-access_token.',
      },
      SESSION_SCHEME,
    );
  for (const [name, description] of TAGS) builder.addTag(name, description);
  return enrichDocument(
    SwaggerModule.createDocument(app, builder.build(), {
      extraModels: [ErrorResponseDto],
    }),
  );
}
