import { INestApplication } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { ModulesContainer, NestFactory, Reflector } from '@nestjs/core';
import type { OpenAPIObject } from '@nestjs/swagger';
import type {
  OperationObject,
  ParameterObject,
  ResponseObject,
  SchemaObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { AppModule } from '../src/app.module';
import { API_PREFIX } from '../src/app.setup';
import { ALLOW_PENDING_PASSWORD_CHANGE_KEY } from '../src/common/decorators/allow-pending-password-change.decorator';
import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator';
import { createOpenApiDocument } from '../src/common/swagger/openapi';

const ERROR_REF = '#/components/schemas/ErrorResponseDto';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

interface Op {
  id: string;
  op: OperationObject;
}

/**
 * Handlers (como operationId, "Controller_método") que tienen la metadata
 * según la leen los guards: handler o clase, con getAllAndOverride.
 */
function handlersWith(app: INestApplication, key: string): string[] {
  const reflector = new Reflector();
  const ids: string[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const { metatype } of module.controllers.values()) {
      const controller = metatype as new () => unknown;
      const proto = controller.prototype as object;
      for (const name of Object.getOwnPropertyNames(proto)) {
        // El descriptor y no proto[name]: no ejecutar getters del controller.
        const handler = Object.getOwnPropertyDescriptor(proto, name)?.value as
          (() => unknown) | undefined;
        if (
          typeof handler !== 'function' ||
          Reflect.getMetadata(METHOD_METADATA, handler) === undefined
        ) {
          continue;
        }
        if (reflector.getAllAndOverride<boolean>(key, [handler, controller])) {
          ids.push(`${controller.name}_${name}`);
        }
      }
    }
  }
  return ids.sort();
}

/**
 * Guardia de completitud del documento OpenAPI (fase 11d): un endpoint o un
 * DTO nuevo sin documentar rompe esta suite. Modo preview: no usa la base.
 */
describe('Swagger (e2e)', () => {
  let app: INestApplication;
  let doc: OpenAPIObject;
  let ops: Op[];

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, {
      preview: true,
      logger: false,
    });
    app.setGlobalPrefix(API_PREFIX);
    doc = createOpenApiDocument(app);
    ops = Object.entries(doc.paths).flatMap(([path, item]) =>
      METHODS.filter((m) => m in item).map((m) => ({
        id: `${m.toUpperCase()} ${path}`,
        op: (item as Record<string, OperationObject>)[m],
      })),
    );
  });

  afterAll(() => app.close());

  /** Lista de fallos: el mensaje del test muestra todos a la vez. */
  const failures = (check: (o: Op) => string | false | undefined) =>
    ops.map((o) => check(o) && `${o.id}: ${check(o)}`).filter(Boolean);

  const responses = (op: OperationObject) =>
    op.responses as Record<string, ResponseObject>;

  it('documenta todas las rutas', () => {
    expect(ops.length).toBeGreaterThan(130);
  });

  it('toda operación tiene summary, un tag declarado y respuesta 2xx con cuerpo (salvo 204)', () => {
    const tags = new Set((doc.tags ?? []).map((t) => t.name));
    expect(
      failures(({ op }) => {
        if (!op.summary) return 'sin summary';
        if (!op.tags?.length || !op.tags.every((t) => tags.has(t))) {
          return `tag sin declarar en openapi.ts: ${op.tags?.join(',')}`;
        }
        const ok = Object.keys(op.responses).filter((s) => /^2/.test(s));
        if (!ok.length) return 'sin respuesta 2xx';
        if (ok.some((s) => s !== '204' && !responses(op)[s].content)) {
          return '2xx sin schema';
        }
      }),
    ).toEqual([]);
  });

  it('solo las rutas @Public() van sin sesión; las demás llevan cookie y 401', () => {
    expect(doc.components?.securitySchemes?.access_token).toMatchObject({
      type: 'apiKey',
      in: 'cookie',
      name: 'access_token',
    });
    const open = ops
      .filter(({ op }) => !op.security)
      .map(({ op }) => op.operationId)
      .sort();
    expect(open).toEqual(handlersWith(app, IS_PUBLIC_KEY));
    expect(open).toContain('AuthController_login');
    expect(
      failures(({ op }) =>
        op.security
          ? JSON.stringify(op.security) !== '[{"access_token":[]}]'
            ? 'security distinto de la cookie access_token'
            : !op.responses['401'] && 'sin 401'
          : undefined,
      ),
    ).toEqual([]);
  });

  it('el 403 de contraseña temporal está en las rutas con sesión salvo @AllowPendingPasswordChange(), una sola vez', () => {
    const pending = 'Debe cambiar la contraseña';
    const withoutPending = ops
      .filter(
        ({ op }) =>
          op.security && !responses(op)['403']?.description.includes(pending),
      )
      .map(({ op }) => op.operationId)
      .sort();
    expect(withoutPending).toEqual(
      handlersWith(app, ALLOW_PENDING_PASSWORD_CHANGE_KEY),
    );
    expect(withoutPending).toEqual([
      'AuthController_changePassword',
      'AuthController_me',
    ]);
    expect(
      failures(({ op }) => {
        const text = responses(op)['403']?.description ?? '';
        return text.split(pending).length > 2 && 'descripción del 403 repetida';
      }),
    ).toEqual([]);
  });

  it('400 con parámetros o body, 404 con id en la ruta, 429 y 500 en todas', () => {
    expect(
      failures(({ id, op }) => {
        const has = (s: string) => s in op.responses;
        if ((op.requestBody || op.parameters?.length) && !has('400')) {
          return 'sin 400';
        }
        if (id.includes('{') && !has('404')) return 'sin 404';
        if (!has('429') || !has('500')) return 'sin 429 o 500';
      }),
    ).toEqual([]);
  });

  it('toda respuesta de error usa ErrorResponseDto', () => {
    expect(
      failures(({ op }) =>
        Object.entries(responses(op))
          .filter(
            ([s, r]) =>
              /^[45]/.test(s) &&
              (r.content?.['application/json']?.schema as { $ref?: string })
                ?.$ref !== ERROR_REF,
          )
          .map(([s]) => s)
          .join(','),
      ),
    ).toEqual([]);
  });

  it('todo parámetro tiene descripción; los de ruta son UUID', () => {
    expect(
      failures(({ op }) =>
        ((op.parameters ?? []) as ParameterObject[])
          .filter(
            (p) =>
              !p.description ||
              (p.in === 'path' &&
                (p.schema as SchemaObject | undefined)?.format !== 'uuid'),
          )
          .map((p) => `${p.in}:${p.name}`)
          .join(','),
      ),
    ).toEqual([]);
  });

  it('toda propiedad de los DTOs tiene descripción o ejemplo (salvo referencias a otro DTO)', () => {
    const missing: string[] = [];
    for (const [name, schema] of Object.entries(
      doc.components?.schemas ?? {},
    )) {
      const properties = (schema as SchemaObject).properties ?? {};
      for (const [prop, value] of Object.entries(properties)) {
        const p = value as SchemaObject & { $ref?: string };
        const isRef = p.$ref || p.allOf || (p.items as { $ref?: string })?.$ref;
        if (!isRef && !p.description && p.example === undefined) {
          missing.push(`${name}.${prop}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('no deja marcas internas en el documento', () => {
    expect(JSON.stringify(doc)).not.toContain('x-aula360-');
  });
});
