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

La documentación de la API (Swagger) queda en `/api/docs` fuera de producción.
