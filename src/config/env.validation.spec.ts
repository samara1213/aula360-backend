import { validateEnv } from './env.validation';

const validEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  CORS_ORIGINS: 'http://localhost:5173,https://app.aula360.co',
  FRONTEND_URL: 'http://localhost:5173',
  JWT_ACCESS_SECRET: 'x'.repeat(64),
  SUPABASE_URL: 'https://abc.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
};

/** Configuración mínima válida para producción. */
const prodEnv = {
  ...validEnv,
  NODE_ENV: 'production',
  CORS_ORIGINS: 'https://app.aula360.co',
  FRONTEND_URL: 'https://app.aula360.co',
  SMTP_HOST: 'smtp.x.co',
  TRUST_PROXY: '1',
  DB_SSL_CA: '-----BEGIN CERTIFICATE-----x-----END CERTIFICATE-----',
};

describe('validateEnv', () => {
  it('acepta una configuración válida y aplica valores por defecto', () => {
    const result = validateEnv({ ...validEnv });
    expect(result.PORT).toBe(3000);
    expect(result.DB_SSL).toBe(true);
    expect(result.TRUST_PROXY).toBe(0);
    expect(result.JWT_ACCESS_EXPIRES_IN).toBe(900);
  });

  it('Swagger: por defecto solo en desarrollo; se puede apagar', () => {
    expect(validateEnv({ ...validEnv }).SWAGGER_ENABLED).toBe(true);
    expect(
      validateEnv({ ...validEnv, SWAGGER_ENABLED: 'false' }).SWAGGER_ENABLED,
    ).toBe(false);
    expect(validateEnv({ ...validEnv, NODE_ENV: 'test' }).SWAGGER_ENABLED).toBe(
      false,
    );
    // Vacío (como en .env.example) = sin definir.
    expect(
      validateEnv({ ...validEnv, SWAGGER_ENABLED: '' }).SWAGGER_ENABLED,
    ).toBe(true);
  });

  it('pool de la base: valores por defecto y límites', () => {
    const result = validateEnv({ ...validEnv });
    expect(result.DB_POOL_MAX).toBe(10);
    expect(result.DB_POOL_CONNECTION_TIMEOUT_MS).toBe(10_000);
    expect(() => validateEnv({ ...validEnv, DB_POOL_MAX: '0' })).toThrow(
      /DB_POOL_MAX/,
    );
    expect(() =>
      validateEnv({ ...validEnv, DB_POOL_CONNECTION_TIMEOUT_MS: '0' }),
    ).toThrow(/DB_POOL_CONNECTION_TIMEOUT_MS/);
  });

  it('DB_SSL_TEST: opcional (vacío = sin definir) y booleano', () => {
    expect(validateEnv({ ...validEnv }).DB_SSL_TEST).toBeUndefined();
    expect(validateEnv({ ...validEnv, DB_SSL_TEST: '' }).DB_SSL_TEST).toBe(
      undefined,
    );
    expect(validateEnv({ ...validEnv, DB_SSL_TEST: 'false' }).DB_SSL_TEST).toBe(
      false,
    );
    expect(() => validateEnv({ ...validEnv, DB_SSL_TEST: 'no' })).toThrow(
      /DB_SSL_TEST/,
    );
  });

  it('convierte números y booleanos recibidos como texto', () => {
    const result = validateEnv({ ...validEnv, PORT: '4000', DB_SSL: 'false' });
    expect(result.PORT).toBe(4000);
    expect(result.DB_SSL).toBe(false);
  });

  it('rechaza si faltan variables obligatorias y las reporta todas', () => {
    expect(() => validateEnv({})).toThrow(
      /NODE_ENV.*DATABASE_URL.*CORS_ORIGINS/,
    );
  });

  it('exige NODE_ENV (sin valor por defecto)', () => {
    const { NODE_ENV: _omit, ...withoutEnv } = validEnv;
    void _omit;
    expect(() => validateEnv(withoutEnv)).toThrow(/NODE_ENV/);
  });

  it.each([
    '*',
    'http://localhost:5173,*',
    'localhost:5173',
    'http://localhost:5173/path',
  ])('rechaza CORS_ORIGINS no explícito: %s', (origins) => {
    expect(() => validateEnv({ ...validEnv, CORS_ORIGINS: origins })).toThrow(
      /CORS_ORIGINS/,
    );
  });

  it('rechaza un JWT_ACCESS_SECRET corto', () => {
    expect(() =>
      validateEnv({ ...validEnv, JWT_ACCESS_SECRET: 'corto' }),
    ).toThrow(/JWT_ACCESS_SECRET/);
  });

  describe('producción', () => {
    it('acepta una configuración completa', () => {
      expect(() => validateEnv(prodEnv)).not.toThrow();
    });

    it('exige SMTP_HOST', () => {
      expect(() => validateEnv({ ...prodEnv, SMTP_HOST: '' })).toThrow(
        /SMTP_HOST/,
      );
    });

    it('exige el certificado CA de la base de datos', () => {
      expect(() => validateEnv({ ...prodEnv, DB_SSL_CA: '' })).toThrow(
        /DB_SSL_CA/,
      );
    });

    it('exige https en CORS_ORIGINS y FRONTEND_URL', () => {
      expect(() =>
        validateEnv({ ...prodEnv, CORS_ORIGINS: 'http://app.aula360.co' }),
      ).toThrow(/CORS_ORIGINS/);
      expect(() =>
        validateEnv({ ...prodEnv, FRONTEND_URL: 'http://app.aula360.co' }),
      ).toThrow(/FRONTEND_URL/);
    });

    it('exige TRUST_PROXY explícito (también 0)', () => {
      expect(() => validateEnv({ ...prodEnv, TRUST_PROXY: undefined })).toThrow(
        /TRUST_PROXY/,
      );
      expect(validateEnv({ ...prodEnv, TRUST_PROXY: '0' }).TRUST_PROXY).toBe(0);
    });

    it('no permite activar Swagger y por defecto lo apaga', () => {
      expect(validateEnv({ ...prodEnv }).SWAGGER_ENABLED).toBe(false);
      expect(() =>
        validateEnv({ ...prodEnv, SWAGGER_ENABLED: 'true' }),
      ).toThrow(/SWAGGER_ENABLED/);
    });

    it('no permite la base sin SSL', () => {
      expect(() => validateEnv({ ...prodEnv, DB_SSL: 'false' })).toThrow(
        /DB_SSL/,
      );
    });

    it('no permite desactivar el rate limiting', () => {
      expect(() =>
        validateEnv({ ...prodEnv, THROTTLE_DISABLED: 'true' }),
      ).toThrow(/THROTTLE_DISABLED/);
    });
  });

  describe('Supabase Storage', () => {
    it('exige URL y service_role key fuera de las e2e', () => {
      expect(() =>
        validateEnv({
          ...validEnv,
          SUPABASE_URL: '',
          SUPABASE_SERVICE_ROLE_KEY: '',
        }),
      ).toThrow(/SUPABASE_URL.*SUPABASE_SERVICE_ROLE_KEY/);
    });

    it('en producción exige https', () => {
      expect(() =>
        validateEnv({ ...prodEnv, SUPABASE_URL: 'http://abc.supabase.co' }),
      ).toThrow(/SUPABASE_URL/);
    });

    it('en e2e (NODE_ENV=test) pueden faltar', () => {
      expect(() =>
        validateEnv({
          ...validEnv,
          NODE_ENV: 'test',
          SUPABASE_URL: '',
          SUPABASE_SERVICE_ROLE_KEY: '',
        }),
      ).not.toThrow();
    });
  });

  it('en desarrollo no exige SMTP_HOST ni DB_SSL_CA', () => {
    expect(() =>
      validateEnv({ ...validEnv, SMTP_HOST: '', DB_SSL_CA: '' }),
    ).not.toThrow();
  });
});
