import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import { setupSwagger } from './app.setup';
import * as openapi from './common/swagger/openapi';

/** App mínima: solo ConfigService con SWAGGER_ENABLED (ya validado). */
function appWith(enabled: unknown): INestApplication {
  const config = { get: () => enabled } as unknown as ConfigService;
  return { get: () => config } as unknown as INestApplication;
}

describe('setupSwagger', () => {
  let setup: jest.SpyInstance;

  beforeEach(() => {
    setup = jest.spyOn(SwaggerModule, 'setup').mockImplementation(() => {});
    jest
      .spyOn(openapi, 'createOpenApiDocument')
      .mockReturnValue({} as ReturnType<typeof openapi.createOpenApiDocument>);
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([false, 'false', undefined])(
    'con SWAGGER_ENABLED=%p no monta /api/docs',
    (value) => {
      expect(setupSwagger(appWith(value))).toBe(false);
      expect(setup).not.toHaveBeenCalled();
    },
  );

  it('con SWAGGER_ENABLED=true monta /api/docs', () => {
    expect(setupSwagger(appWith(true))).toBe(true);
    expect(setup).toHaveBeenCalledWith(
      'api/docs',
      expect.anything(),
      {},
      { swaggerOptions: { withCredentials: true } },
    );
  });
});
