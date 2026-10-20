import type { OpenAPIObject } from '@nestjs/swagger';
import {
  enrichDocument,
  PENDING_PASSWORD_EXTENSION,
  PUBLIC_EXTENSION,
  RESPONSE_DESCRIPTIONS,
} from './enrich-document';

const ERROR = {
  'application/json': {
    schema: { $ref: '#/components/schemas/ErrorResponseDto' },
  },
};

function documentWith(operation: Record<string, unknown>): OpenAPIObject {
  return {
    openapi: '3.0.0',
    info: { title: 't', version: '1' },
    paths: {
      '/api/x/{id}': {
        get: { responses: { 200: { description: 'ok' } }, ...operation },
      },
    },
    components: {
      schemas: {
        XDto: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string', description: 'Propia' },
          },
        },
      },
    },
  };
}

interface TestResponse {
  description: string;
  content?: unknown;
}
interface TestOperation extends Record<string, unknown> {
  security?: unknown;
  responses: Record<string, TestResponse>;
  parameters: unknown[];
}
type TestProperties = Record<string, { description?: string }>;

const op = (doc: OpenAPIObject) =>
  doc.paths['/api/x/{id}'].get as unknown as TestOperation;

describe('enrichDocument', () => {
  it('ruta con sesión: cookie, 401, 403 de contraseña temporal, 429 y 500 con ErrorResponseDto', () => {
    const result = op(enrichDocument(documentWith({})));
    expect(result.security).toEqual([{ access_token: [] }]);
    for (const status of ['401', '403', '429', '500']) {
      expect(result.responses[status].content).toEqual(ERROR);
    }
    expect(result.responses['400']).toBeUndefined();
  });

  it('ruta @Public(): sin cookie ni 401, y sin la marca interna', () => {
    const result = op(
      enrichDocument(documentWith({ [PUBLIC_EXTENSION]: true })),
    );
    expect(result.security).toBeUndefined();
    expect(result.responses['401']).toBeUndefined();
    expect(result[PUBLIC_EXTENSION]).toBeUndefined();
  });

  it('@AllowPendingPasswordChange(): sin el 403 de contraseña temporal', () => {
    const result = op(
      enrichDocument(documentWith({ [PENDING_PASSWORD_EXTENSION]: true })),
    );
    expect(result.responses['403']).toBeUndefined();
    expect(result[PENDING_PASSWORD_EXTENSION]).toBeUndefined();
  });

  it('un 403 propio conserva su texto y suma el de contraseña temporal', () => {
    const result = op(
      enrichDocument(
        documentWith({
          responses: {
            200: { description: 'ok' },
            403: { description: 'Sin permiso' },
          },
        }),
      ),
    );
    expect(result.responses['403'].description).toBe(
      `Sin permiso. También ${RESPONSE_DESCRIPTIONS[403]}`,
    );
  });

  it('con parámetros: 400, y los de ruta quedan como UUID con descripción', () => {
    const result = op(
      enrichDocument(
        documentWith({
          parameters: [{ name: 'id', in: 'path', required: true }],
        }),
      ),
    );
    expect(result.responses['400'].content).toEqual(ERROR);
    expect(result.parameters[0]).toMatchObject({
      schema: { type: 'string', format: 'uuid' },
    });
    expect(result.parameters[0]).toHaveProperty(
      'description',
      'UUID del recurso. Si no existe o es de otra institución: 404',
    );
  });

  it('no modifica los objetos de respuesta que Swagger comparte entre operaciones', () => {
    const shared = { description: 'Sin permiso' };
    const doc = documentWith({});
    doc.paths['/api/y'] = {
      get: { responses: { 200: { description: 'ok' }, 403: shared } },
    };
    (op(doc).responses as Record<string, unknown>)['403'] = shared;
    enrichDocument(doc);
    expect(shared).toEqual({ description: 'Sin permiso' });
    for (const path of ['/api/x/{id}', '/api/y']) {
      const responses = (doc.paths[path].get as unknown as TestOperation)
        .responses;
      expect(responses['403'].description).toBe(
        `Sin permiso. También ${RESPONSE_DESCRIPTIONS[403]}`,
      );
    }
  });

  it('un parámetro de ruta desconocido no se documenta como UUID', () => {
    const result = op(
      enrichDocument(
        documentWith({
          parameters: [
            {
              name: 'slug',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
        }),
      ),
    );
    expect(result.parameters[0]).toEqual({
      name: 'slug',
      in: 'path',
      required: true,
      schema: { type: 'string' },
    });
  });

  it('no pisa respuestas ni descripciones existentes', () => {
    const doc = enrichDocument(
      documentWith({
        responses: {
          200: { description: 'ok' },
          429: { description: 'Máximo 5 por minuto' },
        },
      }),
    );
    expect(op(doc).responses['429'].description).toBe('Máximo 5 por minuto');
    const props = (
      doc.components!.schemas!.XDto as { properties: TestProperties }
    ).properties;
    expect(props.id.description).toBe('Identificador (UUID)');
    expect(props.name.description).toBe('Propia');
  });
});
