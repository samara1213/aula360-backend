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
