# Project: Archive

## Stack

- Runtime: Node.js 24+, TypeScript, ESM modules
- Framework: Fastify 5
- Kysely
- Queue: BullMQ + IORedis
- DB: PostgreSQL (via pg + Kysely)
- Scraping: Flaresolverr, CycleTLS
- Media: hls-parser, ffmpeg
- Auth: @fastify/jwt + bcrypt
- Logging: Pino + pino-pretty
- Process manager: PM2

## Do

- Use ESM import syntax (`import x from 'y'`), never require()
- Use TypeScript — all new files are .ts
- Use Pino for logging, never console.log
- Use dayjs for date manipulation, never Date math directly
- Use Kysely for DB access, not raw SQL unless unavoidable
- Use BullMQ patterns already established in src/workers/
- Static imports are always placed at the very top.
- Store constants in src/constants.ts

## Don't

- Don't install new dependencies without asking
- Don't run migrations without explicit confirmation
- Don't use winston for new code (legacy — pino is the standard now)
- Don't modify ecosystem.config.js without asking
- Don't use CommonJS syntax
- Don't use dynamic imports unless it is a circular dependency.

## Context7 triggers for this project

Use context7 for:

- Fastify 5 API (plugin system, hooks, decorators changed significantly)
- BullMQ 5 (frequent API changes)
- Puppeteer 24 (API changes often)
- Kysely 0.28

Skip context7 for:

- pg, ioredis, redis (stable APIs)
- bcrypt, dayjs, qs, helmet (stable)
- TypeScript, ESLint, Prettier config
- General Node.js/Fastify patterns you're confident about

## After every file edit

- Run `npx tsc --noEmit` to typecheck
- Run `npm run lint` to see any eslint issues
- Run `npm test` to see if tests succeed or fail
- Run `npm run format` to fix formatting issues
- Do not move on to the next task until both pass

## Error handling

- Always use `extractErrorDetails(error)` from `src/utils/error.ts` in catch blocks
- Never use `(error as any).message` or `error instanceof Error ? error.message : String(error)`
