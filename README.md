# survey-for-you (backend skeleton)

Minimal TypeScript + Express + `pg` backend skeleton focused on **idempotent, deterministic** survey logging.

## Requirements

- Node.js
- Postgres

## Environment

- `DATABASE_URL`: used by `npm run dev`
- `DATABASE_URL_TEST`: used by integration tests

## Run migrations

```bash
npm run db:migrate:dev
```

## Run server

```bash
set DATABASE_URL=postgres://...
npm run dev
```

## Run tests

```bash
set DATABASE_URL_TEST=postgres://...
npm test
```

If `DATABASE_URL_TEST` is not set, the integration canary test is skipped.

