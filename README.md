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
yarn test:e2e:all         # todas las e2e en serie (--runInBand --forceExit)
yarn lint
```

## Base de datos local para las e2e

Las e2e contra Supabase tardan unos 35 minutos (latencia y cortes de red); contra un Postgres local, cerca de 1 minuto. Se usa la misma versión que Supabase (17) con los binarios en zip de EDB (sin instalador ni permisos de administrador):

1. Descomprimir `postgresql-17.x-windows-x64-binaries.zip` (https://www.enterprisedb.com/download-postgresql-binaries) en una carpeta fuera del repositorio, por ejemplo `%USERPROFILE%\postgres\pgsql`.
2. Crear el clúster con la configuración regional de Supabase y una contraseña propia en un archivo:
   `pgsql\bin\initdb -D data17 -U postgres --pwfile=<archivo> -A scram-sha-256 -E UTF8 --locale-provider=icu --icu-locale=en-US --locale=en-US`
   y borrar el archivo de la contraseña después.
3. En `data17\postgresql.conf`: `listen_addresses = 'localhost'` y `timezone = 'UTC'`. Como es una base desechable, también `fsync = off`, `synchronous_commit = off` y `full_page_writes = off` (más rápida; un apagón puede dañarla y se vuelve a crear).
4. Iniciar con `pgsql\bin\pg_ctl -D data17 -l postgres.log start` (no es un servicio: hay que iniciarlo tras reiniciar el equipo) y crear la base y los roles de Supabase (sin ellos, la migración de permisos no se ejercita):
   `CREATE DATABASE aula360_e2e; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;`
5. En `.env`: `E2E_DB_MODE=isolated`, `DATABASE_URL_TEST=postgresql://postgres:<contraseña>@localhost:5432/aula360_e2e` y `DB_SSL_TEST=false`.
6. Migraciones y seed sobre esa base, con las variables en la línea de comandos (dotenv no reemplaza las que ya existen); los `SEED_SUPERADMIN_*` vacíos omiten el SUPER_ADMIN, porque las e2e crean el suyo:
   `DATABASE_URL=<DATABASE_URL_TEST> DB_SSL=false SEED_SUPERADMIN_EMAIL= SEED_SUPERADMIN_DOCUMENT_NUMBER= SEED_SUPERADMIN_FIRST_NAME= SEED_SUPERADMIN_LAST_NAME= SEED_SUPERADMIN_PASSWORD= yarn migration:run`
   y lo mismo con `yarn seed`. Repetir `migration:run` (con esas variables) cada vez que se agregue una migración.

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

**Procesos:** una sola instancia del backend mientras la generación masiva de boletines y los límites de peticiones guarden su estado en memoria (ver la deuda técnica en `tasks.md`). Procesos periódicos dentro de la app: reintentos de borrados de Storage (cada 5 min, `STORAGE_DELETIONS_DISABLED`) y purga de tokens vencidos hace más de 30 días (cada 6 h, `TOKEN_CLEANUP_DISABLED`). La purga recorre las tablas de tokens sin índice en `expires_at`: vigilar su duración frente al `statement_timeout`; si crece, crear el índice con una migración (`CREATE INDEX CONCURRENTLY`). Si la primera pasada en producción borra mucho, revisar `n_dead_tup` y, si hace falta, `VACUUM` manual.

**Logs:** TypeORM nunca escribe los parámetros de las consultas (logger propio); no usar `NODE_ENV=development` con datos reales (sin SMTP, el texto de los correos va al log).
