import * as Joi from 'joi';

/**
 * Variables de entorno validadas al arrancar. Si falta una obligatoria o tiene
 * un formato inválido, la aplicación no inicia.
 */
export const envValidationSchema: Joi.ObjectSchema<Record<string, unknown>> =
  Joi.object({
    // Obligatoria y sin valor por defecto: olvidarla no puede apagar protecciones de producción.
    NODE_ENV: Joi.string()
      .valid('development', 'test', 'production')
      .required(),
    PORT: Joi.number().port().default(3000),
    // Saltos de proxy inverso de confianza (0 = ninguno). Necesario para que el
    // rate limiting use la IP real del cliente detrás de un balanceador.
    // En producción es obligatorio (también 0, si no hay proxy): olvidarlo
    // detrás de un balanceador haría que todos compartan su IP (M3 de la fase 11e).
    TRUST_PROXY: Joi.number()
      .integer()
      .min(0)
      .max(10)
      .when('NODE_ENV', {
        is: 'production',
        then: Joi.required(),
        otherwise: Joi.optional().default(0),
      }),

    DATABASE_URL: Joi.string()
      .uri({ scheme: ['postgres', 'postgresql'] })
      .required(),
    // En producción siempre con SSL (B3 de la fase 11e).
    DB_SSL: Joi.boolean()
      .default(true)
      .when('NODE_ENV', { is: 'production', then: Joi.valid(true) }),
    // Certificado CA de Supabase en PEM (se aceptan saltos de línea escritos como \n).
    // En producción es obligatorio: la conexión verifica el certificado del servidor.
    DB_SSL_CA: Joi.string()
      .allow('')
      .when('NODE_ENV', {
        is: 'production',
        then: Joi.string().invalid('').required(),
        otherwise: Joi.optional(),
      }),
    // Pool de conexiones de la app (pg): sin tope de espera, una petición
    // colgada esperaría para siempre una conexión libre.
    DB_POOL_MAX: Joi.number().integer().min(1).max(100).default(10),
    DB_POOL_CONNECTION_TIMEOUT_MS: Joi.number()
      .integer()
      .min(1000)
      .max(60_000)
      .default(10_000),
    E2E_DB_MODE: Joi.string().valid('shared', 'isolated').optional(),
    DATABASE_URL_TEST: Joi.string()
      .uri({ scheme: ['postgres', 'postgresql'] })
      .allow('')
      .optional(),

    // Lista separada por comas. Nunca '*' (las cookies requieren origen explícito).
    // En producción solo https.
    CORS_ORIGINS: Joi.string()
      .required()
      .custom((value: string, helpers) => {
        const ancestors = helpers.state.ancestors as { NODE_ENV?: string }[];
        const env = ancestors[0];
        const pattern =
          env?.NODE_ENV === 'production'
            ? /^https:\/\/[^/]+$/
            : /^https?:\/\/[^/]+$/;
        const origins = value.split(',').map((o) => o.trim());
        if (origins.some((o) => o === '*' || !pattern.test(o))) {
          return helpers.error('any.invalid');
        }
        return value;
      }, 'lista de orígenes explícitos'),
    // Va en los enlaces de los correos: en producción solo https.
    FRONTEND_URL: Joi.string()
      .uri()
      .required()
      .when('NODE_ENV', {
        is: 'production',
        then: Joi.string().uri({ scheme: ['https'] }),
      }),

    // Chromium de los boletines: sin sandbox solo en contenedores que corren
    // como root y no lo permiten (en lo posible, usar un usuario sin privilegios).
    PDF_CHROMIUM_NO_SANDBOX: Joi.boolean().default(false),
    // Apaga el proceso que reintenta los borrados pendientes de Storage (por
    // ejemplo, en una instancia que no debe tocar Supabase). En e2e no corre.
    STORAGE_DELETIONS_DISABLED: Joi.boolean().default(false),

    // /api/docs: por defecto solo en desarrollo; nunca en producción (B6 de la
    // revisión de la fase 11d). No pide sesión: no activarlo en un entorno expuesto.
    SWAGGER_ENABLED: Joi.boolean()
      .empty('')
      .default(
        (parent: { NODE_ENV?: string }) => parent.NODE_ENV === 'development',
      )
      .when('NODE_ENV', { is: 'production', then: Joi.valid(false) }),

    THROTTLE_DISABLED: Joi.boolean()
      .default(false)
      .when('NODE_ENV', { is: 'production', then: Joi.valid(false) }),
    JWT_ACCESS_SECRET: Joi.string().min(32).required(),
    JWT_ACCESS_EXPIRES_IN: Joi.number().integer().min(60).default(900),
    REFRESH_TOKEN_TTL_DAYS: Joi.number().integer().min(1).max(30).default(7),

    // Solo los usa el seed; se validan allí.
    SEED_SUPERADMIN_EMAIL: Joi.string().allow('').optional(),
    SEED_SUPERADMIN_DOCUMENT_TYPE: Joi.string().allow('').optional(),
    SEED_SUPERADMIN_DOCUMENT_NUMBER: Joi.string().allow('').optional(),
    SEED_SUPERADMIN_FIRST_NAME: Joi.string().allow('').optional(),
    SEED_SUPERADMIN_LAST_NAME: Joi.string().allow('').optional(),
    SEED_SUPERADMIN_PASSWORD: Joi.string().allow('').optional(),

    // Correo: vacío = en desarrollo los correos solo se registran en el log.
    // En producción el correo es obligatorio (recuperación de contraseña).
    SMTP_HOST: Joi.string()
      .allow('')
      .when('NODE_ENV', {
        is: 'production',
        then: Joi.string().invalid('').required(),
        otherwise: Joi.optional(),
      }),
    SMTP_PORT: Joi.number().port().default(587),
    SMTP_USER: Joi.string().allow('').optional(),
    SMTP_PASS: Joi.string().allow('').optional(),
    MAIL_FROM: Joi.string().allow('').optional(),

    // Supabase Storage. Obligatorias salvo en e2e (NODE_ENV=test usa un Storage falso).
    // En producción solo https.
    SUPABASE_URL: Joi.when('NODE_ENV', {
      switch: [
        { is: 'test', then: Joi.string().uri().allow('').optional() },
        {
          is: 'production',
          then: Joi.string()
            .uri({ scheme: ['https'] })
            .required(),
        },
      ],
      otherwise: Joi.string().uri().required(),
    }),
    // service_role key: solo backend, jamás en el frontend ni en logs.
    SUPABASE_SERVICE_ROLE_KEY: Joi.string()
      .allow('')
      .when('NODE_ENV', {
        is: 'test',
        then: Joi.optional(),
        otherwise: Joi.string().invalid('').required(),
      }),
  });

/** Para ConfigModule.forRoot({ validate }): reporta todos los errores juntos. */
export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const result = envValidationSchema.validate(config, {
    abortEarly: false,
    allowUnknown: true,
    convert: true,
  });
  if (result.error) {
    throw new Error(
      `Variables de entorno inválidas: ${result.error.details.map((d) => d.message).join('; ')}`,
    );
  }
  return result.value;
}
