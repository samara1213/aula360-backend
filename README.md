# aula360-backend
proyecto de instituciones educativas api

API de Aula360 (SaaS multi-institución para instituciones educativas en Colombia), construida con NestJS, TypeORM y PostgreSQL (Supabase).

## Requisitos

- Node.js 22 y Yarn 1.x
- Archivo `.env` basado en `.env.example` (nunca subirlo al repositorio)

## Comandos

```bash
yarn install
yarn start:dev            # desarrollo
yarn build                # compilar
yarn migration:run        # aplicar migraciones
yarn seed                 # datos base (menús, roles, permisos, SUPER_ADMIN)
yarn test                 # pruebas unitarias
yarn test:e2e --runInBand # pruebas e2e (requiere E2E_DB_MODE en .env)
yarn lint
```

La documentación de la API (Swagger) queda en `/api/docs` cuando `SWAGGER_ENABLED` está activa (por defecto solo en `development`; prohibida en producción). `yarn openapi:export openapi.json` genera el documento OpenAPI para el frontend.

## Lista para producción

**Entorno** (la app no arranca si falta algo obligatorio; ver `.env.example`):
- `NODE_ENV=production`: cookies `secure` con prefijos `__Host-`/`__Secure-`, Swagger apagado y límites de peticiones siempre activos.
- `CORS_ORIGINS` y `FRONTEND_URL` solo con los orígenes https del frontend (nunca `*` ni orígenes de prueba).
- `TRUST_PROXY` (obligatorio en producción, también `0`) con el número exacto de proxies delante de la API; si no, el límite por IP cuenta la IP del balanceador.
- `DB_SSL` no se puede desactivar en producción; las migraciones (`yarn migration:run`) también exigen `DB_SSL_CA`.
- `JWT_ACCESS_SECRET` aleatorio de 64+ caracteres, distinto en cada entorno.
- `DB_SSL_CA` con el certificado de Supabase (la conexión verifica el servidor). `DB_POOL_MAX` según el tamaño del pooler.
- `SUPABASE_SERVICE_ROLE_KEY` solo en el backend; nunca en el frontend ni en logs.
- `SEED_SUPERADMIN_PASSWORD` vacío después del seed.

**Supabase:**
- `yarn migration:run` (RLS en todas las tablas y sin permisos para `anon` y `authenticated`) y `yarn storage:setup`.
- Quitar `public` de los esquemas expuestos de la Data API (el backend no la usa).
- Fijar tiempos máximos en el rol de la app (el pooler ignora los parámetros de conexión), por ejemplo `ALTER ROLE postgres SET idle_in_transaction_session_timeout = '60s'` y `ALTER ROLE postgres SET statement_timeout = '30s'` (las migraciones largas pueden necesitar `SET statement_timeout = 0` en su sesión).
- Solo el bucket `logos` es público.

**Correo:** proveedor transaccional con dominio propio y SPF, DKIM y DMARC (tarea 2.11.8). La cuenta de Gmail es solo para pruebas: revocar su contraseña de aplicación.

**Boletines (Chromium):** el contenedor necesita las librerías de Chrome y fuentes (DejaVu o Liberation), idealmente sin salida a Internet; `PDF_CHROMIUM_NO_SANDBOX=true` solo si corre como root.

**Procesos:** una sola instancia del backend mientras la generación masiva de boletines y los límites de peticiones guarden su estado en memoria (ver la deuda técnica en `tasks.md`).

**Logs:** TypeORM nunca escribe los parámetros de las consultas (logger propio); no usar `NODE_ENV=development` con datos reales (sin SMTP, el texto de los correos va al log).
