---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-08T09:11:03-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-08T10:07:03-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-09-08T09:13:57-03:00"
  docs/phases/phase-02-auth/context.md: "2026-09-08T09:13:57-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-09-08T09:13:57-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-09-08T09:11:03-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-08T10:07:03-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de informações do vídeo, categorias, visibilidade pública/unlisted, fluxo de publicação e painel do canal (Fase 04). Player, contagem de visualizações e sugestões (Fase 05). Likes, comentários e inscrições (Fase 06).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — Fase 03 has no UI capability bullet; the video player screen is `Fase 05 — Página de Visualização do Vídeo`.

**Sequencing notes:** Depends on Fase 01 (Docker Compose environment, config namespaces, migrations) and Fase 02 (authenticated user with a 1:1 channel — a video belongs to a channel).

**Neighbors (for boundary detection only):**

- **Fase 02:** Cadastro, Login e Gerenciamento de Conta — supplies the authenticated user, the JWT guard and the channel a video belongs to.
- **Fase 04:** Gerenciamento de Vídeos e Canal — consumes the video entity created here and adds editing, categories, visibility and the management panel.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Object Storage Client and Bucket/Key Organization | decided | A (AWS SDK v3 + presigner, single bucket with prefixes) | @aws-sdk/client-s3@^3.1127.0, @aws-sdk/s3-request-presigner@^3.1127.0 |
| phase-03-videos/TD-02 | phase | Backend | Background Job Queue Technology | decided | A (BullMQ over Redis via @nestjs/bullmq) | bullmq@^5.81.4, @nestjs/bullmq@^11.0.5 |
| phase-03-videos/TD-03 | phase | Cross-layer | Large-File Upload Strategy (up to 10GB) | decided | A (S3 multipart with presigned part URLs) | — |
| phase-03-videos/TD-04 | phase | Backend | Video Status Lifecycle and Processing-Failure Policy | decided | A (draft → processing → ready \| failed, terminal failure) | — |
| phase-03-videos/TD-05 | phase | Backend | Video Worker Runtime and Deployment Topology | decided | A (separate Compose service, standalone Nest context) | — |
| phase-03-videos/TD-06 | phase | Backend | Metadata Extraction and Thumbnail Generation Toolchain | decided | A (execFile ffprobe/ffmpeg over presigned GET URL) | — |
| phase-03-videos/TD-07 | phase | Backend | Unique Video URL Identifier Strategy | decided | A (11-char base64url slug from node:crypto) | — |
| phase-03-videos/TD-08 | phase | Backend | Video Streaming Delivery Strategy | decided | A (API answers Range with 206 Partial Content) | — |
| phase-03-videos/TD-09 | phase | Backend | Video Download Delivery | decided | A (dedicated route, Content-Disposition attachment) | — |
| phase-03-videos/TD-10 | phase | Backend | Test Strategy for the New External Infrastructure | decided | A (real MinIO/Redis/FFmpeg from Compose) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-01, phase-03-videos/TD-10 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-02, phase-03-videos/TD-10 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-04 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-10 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-06 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-08 |
| Download do vídeo pelo usuário | phase-03-videos/TD-09 |

## Decisions Detail

_(current-phase TDs — from `docs/decisions/technical-decisions-phase-03-videos.md`)_

### phase-03-videos/TD-01

**Recommendation:** `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, single bucket with `videos/{videoId}/…` and `thumbnails/{videoId}/…` prefixes. The presigner is a hard requirement of TD-03's upload handshake, and the single-bucket prefix layout makes a video's whole footprint addressable by one prefix. Per-entity buckets can be introduced later without touching the stored keys, because the key already carries the entity namespace.

**Libraries:** `@aws-sdk/client-s3@^3.1127.0`, `@aws-sdk/s3-request-presigner@^3.1127.0`

### phase-03-videos/TD-02

**Recommendation:** BullMQ + Redis — the only option that gives first-party NestJS integration *and* built-in retry/backoff/failed-set semantics, which is exactly the surface TD-04's `failed` status needs. The cost is one Redis container, which is small next to the hand-rolled worker lifecycle a Postgres-backed queue requires and the broker topology RabbitMQ requires. Redis is configured with AOF persistence so a broker restart does not silently drop queued jobs.

**Libraries:** `bullmq@^5.81.4`, `@nestjs/bullmq@^11.0.5`

**Revision (2026-09-08):** version pins moved to the CommonJS-compatible line — `@nestjs/bullmq@12` is ESM-only and cannot be required by this project.

### phase-03-videos/TD-03

**Recommendation:** S3 multipart with presigned part URLs — the only option that both keeps the payload out of the API and expresses a 10GB object, and it reuses the storage client TD-01 already introduces instead of adding a fourth service. The extra client complexity is the correct place to pay: the client is the only party that holds the file. Server-side declared size is validated against a 10GB ceiling at `POST /videos` so an oversized upload is rejected before a single part is presigned.

**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** The four states the brief names (`draft → processing → ready | failed`), terminal `failed` after a bounded retry budget (3 attempts, exponential backoff, supplied by TD-02), and a `processing_error` column carrying the reason. The abandoned-draft gap is accepted for this phase and handled by aborting the underlying multipart upload when a draft is deleted; a scheduled reaper is out of scope here and is noted for a later phase.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** A `video-worker` Compose service running a NestJS standalone application context off the shared source tree, built from a Dockerfile that installs `ffmpeg` (which brings `ffprobe`). It matches the target architecture, isolates CPU, and reuses the exact entity and config code the API uses, so schema drift between writer and reader is structurally impossible.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** `execFile`-based invocation of `ffprobe`/`ffmpeg` against a short-lived presigned GET URL. It adds no dependency, keeps 10GB off the worker's disk by relying on FFmpeg's HTTP range reads, and the `ffprobe` JSON contract is the most testable of the three. The thumbnail is captured at a seek point derived from the probed duration (10%, clamped to at least 1s) so that black lead-in frames are avoided, then uploaded to `thumbnails/{videoId}/thumbnail.jpg`.

**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** An 11-character `base64url` slug from `node:crypto`, held in a unique-indexed `slug` column with retry-on-collision. It satisfies "curta e única" with a database-enforced guarantee, adds no dependency, sidesteps the `nanoid` ESM/CommonJS trap, and reuses the collision-retry convention the codebase already established for channel nicknames.

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** The API answers `Range` with `206 Partial Content`, streaming only the requested window out of storage. Per-request authorization is the deciding factor: Fase 04 introduces `unlisted`, and a bearer-grade presigned link cannot express it. The bandwidth cost is bounded and acceptable at this stage, and the presigned-redirect path remains available later as a pure delivery optimization behind the same endpoint, without changing the API contract.

**Note (resolves IC-1):** `docs/diagrams/software-arch.mermaid` draws `Rel(frontend, storage, "Streams", "HTTPS")`. That relation describes the delivery optimisation the presigned-redirect option enables, not the Phase 03 contract; `GET /videos/:slug/stream` is the stable route and its body can become a `302` later without a contract change.

**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** A dedicated `GET /videos/:slug/download` streaming the object with `Content-Disposition: attachment`, sharing the storage-read helper with the streaming route. It keeps the two capability bullets separately observable, keeps one authorization model across both delivery paths, and leaves room for download-specific policy later.

**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** Real MinIO, real Redis and real FFmpeg from the Compose stack, mirroring how PostgreSQL and Mailpit are already used, with per-test key namespacing and explicit cleanup for isolation. The video fixture is generated at test time via FFmpeg's `testsrc`/`lavfi` inputs, so no binary artifact enters the repository and the decoder path is genuinely exercised.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability. The `registerAs()` factory is dual-purpose: DI token + plain importable function.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — `data-source.ts` imports the factory, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-02

**Recommendation:** Custom guards with `@nestjs/jwt` only. `JwtAuthGuard` is registered as a global `APP_GUARD`, so every endpoint is protected by default and public routes opt out with `@Public()`.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting via `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-10

**Recommendation:** Option A (`[a-z0-9_]` allowlist + `user_<random>` fallback) — the channel handle is generated from the email prefix and uniqueness is resolved by a pre-check query plus retry on the unique-constraint violation, never by savepoints in the creation path.

**Libraries:** —

_Frontend slice `phase-02-auth-frontend` (TD-01…TD-07) decided the BFF session model, form library and mutation pathway for `next-frontend/`. That subproject is deferred in this phase (no UI capability bullet), so none of those TDs constrain Phase 03 work; they are recorded here for lineage only._

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `autoLoadEntities: true` and `synchronize: false`; every entity is registered in its owning module via `TypeOrmModule.forFeature([...])`. _(from phase 01)_
- Every service host referenced from code or env uses the Docker Compose service name, never `localhost`. _(from phase 01)_
- HTTP errors use the `{ statusCode, error, message }` envelope produced by `DomainExceptionFilter`; services throw `DomainException` subclasses and never NestJS HTTP exceptions. _(from phase 02)_
- `JwtAuthGuard` is a global `APP_GUARD`: endpoints are protected by default and public ones opt out with `@Public()`. The authenticated payload is read with the `@CurrentUser()` param decorator. _(from phase 02)_
- Request DTOs live in `<module>/dto/*.dto.ts` with `class-validator` decorators only — the `@nestjs/swagger` CLI plugin derives the OpenAPI schema; response DTOs need explicit `@ApiProperty`. _(from phase 02)_
- Controllers carry `@ApiTags`, one `@ApiOperation` and one `@ApiResponse` per predictable status, with error responses referencing `getSchemaPath(ApiErrorEnvelope)`. _(from phase 02)_
- Uniqueness collisions on generated public handles are resolved by a pre-check query plus retry on the unique-constraint violation. _(from phase 02)_
- Migrations are generated with the TypeORM CLI and committed under `src/database/migrations/`; test DataSources import migration classes and entity classes explicitly instead of globs. _(from phase 01, phase 02)_
- Integration and E2E suites share one database and run with `--runInBand`; E2E specs re-apply `main.ts` global pipes and filters manually. _(from phase 02)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` was not initialized in Phase 01. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | Delivered later by the `phase-02-auth-frontend` slice. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| _None._ | | | |

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit (branch logic, mocked repo) + Integration (DB contract) |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, queue client) | Unit: real lib with test config |
| Service with side-effect dep (storage, email, queue) | Integration: real service from Compose |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — no unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (custom logic) | Unit + E2E |
| Exception Filter | Unit + E2E |

Layer selection follows the `testing-guide-nestjs-project` Skill; suffix selection (`*.spec.ts` / `*.integration-spec.ts` / `*.e2e-spec.ts`) follows `nestjs-project/CLAUDE.md` → "Test Type Selection". Per-SI coverage is recorded in `progress.md`.
