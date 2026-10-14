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
    TRUST_PROXY: Joi.number().integer().min(0).max(10).default(0),

    DATABASE_URL: Joi.string()
      .uri({ scheme: ['postgres', 'postgresql'] })
      .required(),
    DB_SSL: Joi.boolean().default(true),
    // Certificado CA de Supabase en PEM (se aceptan saltos de línea escritos como \n).
    // En producción es obligatorio: la conexión verifica el certificado del servidor.
    DB_SSL_CA: Joi.string()
      .allow('')
      .when('NODE_ENV', {
        is: 'production',
        then: Joi.string().invalid('').required(),
        otherwise: Joi.optional(),
      }),
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

    // Supabase Storage (obligatorias a partir de la fase 6).
    SUPABASE_URL: Joi.string().uri().allow('').optional(),
    SUPABASE_SERVICE_ROLE_KEY: Joi.string().allow('').optional(),
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
