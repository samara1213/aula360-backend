import type { OpenAPIObject } from '@nestjs/swagger';
import type {
  OperationObject,
  ResponseObject,
  ResponsesObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

/** Esquema de seguridad de la cookie del access token (ver setupSwagger). */
export const SESSION_SCHEME = 'access_token';

/** Marcas internas que ponen @Public() y @AllowPendingPasswordChange(); no salen en el documento. */
export const PUBLIC_EXTENSION = 'x-aula360-public';
export const PENDING_PASSWORD_EXTENSION = 'x-aula360-allow-pending-password';

const ERROR_SCHEMA = { $ref: '#/components/schemas/ErrorResponseDto' };
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];

export const RESPONSE_DESCRIPTIONS = {
  400: 'Datos inválidos: en errores de validación `message` es la lista de errores',
  401: 'Sin sesión válida: cookie ausente o vencida, sesión revocada, usuario inactivo o sin acceso a la institución activa. Renovar con POST /api/auth/refresh-token',
  403: '«Debe cambiar la contraseña» mientras la contraseña sea temporal',
  429: 'Límite de peticiones superado; la cabecera Retry-After indica cuántos segundos esperar',
  500: 'Error interno (mensaje genérico, sin detalles)',
} as const;

/**
 * Parámetros de ruta conocidos (se validan con ParseUUIDPipe). Uno nuevo queda
 * sin descripción y la guardia de test/swagger.e2e-spec.ts lo detecta.
 */
const PATH_PARAMS: Record<string, string> = {
  id: 'UUID del recurso. Si no existe o es de otra institución: 404',
  institutionId: 'UUID de la institución',
  courseId: 'UUID del curso',
  studentId: 'UUID del estudiante (su usuario)',
};

/** Campos que se repiten en casi todos los DTOs: misma descripción en toda la API. */
const COMMON_PROPERTIES: Record<string, string> = {
  id: 'Identificador (UUID)',
  institutionId: 'UUID de la institución',
  name: 'Nombre',
  firstName: 'Nombres',
  lastName: 'Apellidos',
  email: 'Correo electrónico',
  phone: 'Teléfono',
  isActive: 'false si está desactivado (borrado lógico)',
  createdAt: 'Fecha de creación (ISO 8601)',
  updatedAt: 'Fecha de la última modificación (ISO 8601)',
};

type Marked = OperationObject & Record<string, unknown>;
type PropertySchema = { description?: string; example?: unknown };

function add(responses: ResponsesObject, status: number, description: string) {
  responses[status] ??= { description };
}

/**
 * Swagger comparte entre las operaciones de un controller los objetos de las
 * respuestas declaradas en la clase: nunca se modifican, se reemplazan.
 */
function replace(
  responses: ResponsesObject,
  status: string,
  changes: Partial<ResponseObject>,
) {
  responses[status] = { ...(responses[status] as ResponseObject), ...changes };
}

/**
 * Completa en todas las operaciones lo que aplica a toda la API, para no
 * repetirlo en cada método:
 * - Sin @Public(): cookie de sesión, 401 y el 403 de contraseña temporal
 *   (salvo @AllowPendingPasswordChange()).
 * - 400 si recibe parámetros o body; 429 (ThrottlerGuard global) y 500.
 * - El cuerpo ErrorResponseDto en toda respuesta de error.
 */
export function enrichDocument(document: OpenAPIObject): OpenAPIObject {
  for (const item of Object.values(document.paths)) {
    for (const method of METHODS) {
      const op = (item as Record<string, Marked | undefined>)[method];
      if (!op) continue;
      const isPublic = op[PUBLIC_EXTENSION] === true;
      const allowsPendingPassword = op[PENDING_PASSWORD_EXTENSION] === true;
      delete op[PUBLIC_EXTENSION];
      delete op[PENDING_PASSWORD_EXTENSION];
      const responses = (op.responses = { ...op.responses });

      if (isPublic) {
        delete op.security;
      } else {
        op.security = [{ [SESSION_SCHEME]: [] }];
        add(responses, 401, RESPONSE_DESCRIPTIONS[401]);
        if (!allowsPendingPassword) {
          const forbidden = responses[403] as ResponseObject | undefined;
          if (!forbidden) add(responses, 403, RESPONSE_DESCRIPTIONS[403]);
          else {
            replace(responses, '403', {
              description: `${forbidden.description}. También ${RESPONSE_DESCRIPTIONS[403]}`,
            });
          }
        }
      }
      for (const param of op.parameters ?? []) {
        if ('$ref' in param || param.in !== 'path') continue;
        if (!(param.name in PATH_PARAMS)) continue;
        param.description ??= PATH_PARAMS[param.name];
        param.schema = { type: 'string', format: 'uuid' };
      }
      if (op.requestBody || op.parameters?.length) {
        add(responses, 400, RESPONSE_DESCRIPTIONS[400]);
      }
      add(responses, 429, RESPONSE_DESCRIPTIONS[429]);
      add(responses, 500, RESPONSE_DESCRIPTIONS[500]);

      for (const [status, response] of Object.entries(responses)) {
        if (!response || !/^[45]/.test(status) || '$ref' in response) {
          continue;
        }
        if (!response.content) {
          replace(responses, status, {
            content: { 'application/json': { schema: ERROR_SCHEMA } },
          });
        }
      }
    }
  }
  for (const schema of Object.values(document.components?.schemas ?? {})) {
    if ('$ref' in schema) continue;
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      const prop = property as PropertySchema;
      if (prop.description === undefined && COMMON_PROPERTIES[name]) {
        prop.description = COMMON_PROPERTIES[name];
      }
    }
  }
  return document;
}
