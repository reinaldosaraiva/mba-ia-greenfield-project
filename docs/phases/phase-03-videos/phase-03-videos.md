---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-08T09:11:03-03:00"
  docs/phases/phase-03-videos/context.md: "2026-09-08T09:44:40-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-08T09:43:31-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-08T09:42:36-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the video ingestion pipeline end to end — a draft row created the moment an upload starts, a 10GB file transferred straight to object storage without passing through the API, automatic background processing that extracts duration and metadata and cuts a thumbnail, a short unique URL per video, and range-based streaming plus download — establishing the storage, queue and worker infrastructure every later video phase builds on.

---

## Step Implementations

### SI-03.1 — Dependências, namespaces de configuração e serviços de infraestrutura

**Description:** Install the four libraries this phase pins, add the `storage`, `queue` and `video` config namespaces following the `registerAs` pattern inherited from Fase 01, extend the Joi schema and `.env.example`, and bring MinIO and Redis up in Docker Compose. Nothing in this SI has behavior of its own — it is the substrate every later SI depends on.

**Technical actions:**

- Install production dependencies in `nestjs-project`: `@aws-sdk/client-s3@^3.1127.0`, `@aws-sdk/s3-request-presigner@^3.1127.0` (per `phase-03-videos/TD-01`), `bullmq@^6.3.4`, `@nestjs/bullmq@^12.0.0` (per `phase-03-videos/TD-02`)
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `STORAGE_ENDPOINT` (default `http://minio:9000`), `STORAGE_REGION` (default `us-east-1`), `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_BUCKET` (default `streamtube`)
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`) — and `src/config/video.config.ts` — `registerAs('video', ...)` reading `VIDEO_MAX_UPLOAD_BYTES` (default `10737418240`), `VIDEO_UPLOAD_PART_SIZE_BYTES` (default `10485760`), `VIDEO_UPLOAD_URL_EXPIRATION_SECONDS` (default `3600`), `VIDEO_PROCESSING_URL_EXPIRATION_SECONDS` (default `900`), `VIDEO_PROCESSING_ATTEMPTS` (default `3`), `VIDEO_THUMBNAIL_POSITION_RATIO` (default `0.1`), `VIDEO_ALLOWED_MIME_TYPES` (comma-separated, default `video/mp4,video/quicktime,video/webm,video/x-matroska`)
- Extend `src/config/env.validation.ts` with every new variable (Joi defaults mirroring the factories, `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` required), update `.env.example`, and register the three namespaces in `AppModule`'s `ConfigModule.forRoot({ load: [...] })`
- Add `minio` (image `minio/minio`, command `server /data --console-address ":9001"`, ports `9000`/`9001`, named volume, healthcheck) and `redis` (image `redis:8-alpine`, `--appendonly yes` per `phase-03-videos/TD-02`, healthcheck `redis-cli ping`) to `nestjs-project/compose.yaml`; make `nestjs-api` depend on both being healthy, and install `ffmpeg` in `Dockerfile.dev` so the test runner has the toolchain `phase-03-videos/TD-10` requires

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/config/env.validation.integration-spec.ts` | Integration | New variables validate: defaults applied when absent, bootstrap rejected when `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` are missing, numeric coercion for the byte/second limits |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` brings `minio` and `redis` to a healthy state alongside `db`, `mailpit` and `nestjs-api`
- Starting the application without `STORAGE_ACCESS_KEY_ID` fails at bootstrap with a Joi validation error — the app does not start
- Starting the application with only the required variables set applies every documented default (`VIDEO_MAX_UPLOAD_BYTES` resolves to 10737418240, `VIDEO_UPLOAD_PART_SIZE_BYTES` to 10485760)
- `ffmpeg -version` and `ffprobe -version` both succeed inside the `nestjs-api` container

---

### SI-03.2 — Entidade Video, migration e módulo

**Description:** Create the `Video` entity linked to `Channel`, generate the migration that creates the `videos` table and its status enum, and register the entity in a new `VideosModule`. Also extend the shared test helpers so every other suite keeps a clean database.

**Technical actions:**

- Create `src/videos/videos.constants.ts` — `VIDEO_PROCESSING_QUEUE`, `VIDEO_PROCESSING_JOB`, `VIDEO_SOURCE_PREFIX`, `VIDEO_THUMBNAIL_PREFIX`, `VIDEO_SLUG_LENGTH` (all `as const`), and the `VideoStatus` enum (`draft`, `processing`, `ready`, `failed`) per `phase-03-videos/TD-04`
- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with the columns in `## Technical Specifications → Data Model`, `@ManyToOne(() => Channel)` with `@JoinColumn({ name: 'channel_id' })`, unique index on `slug`, index on `channel_id`, and a `bigint` `size_bytes` column with a `transformer` converting the driver's string to `number`
- Add the inverse side `@OneToMany(() => Video, video => video.channel)` to `src/channels/entities/channel.entity.ts` (per the inherited convention that both sides of a relation are declared)
- Generate the migration with `npm run migration:generate -- src/database/migrations/CreateVideos` and review the emitted SQL for the enum type, the FK, and both indexes
- Create `src/videos/videos.module.ts` with `TypeOrmModule.forFeature([Video])` and export `TypeOrmModule`; register `VideosModule` in `AppModule`; extend `cleanAllTables` in `src/test/create-test-data-source.ts` and the managed table/enum lists in `src/database/migrations.integration-spec.ts` with `videos` and `videos_status_enum`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Unique `slug` constraint, `status` defaults to `draft`, enum rejects unknown values, `channel_id` FK enforced, `duration_seconds` / `thumbnail_key` / `processing_error` nullable, `size_bytes` round-trips as a number above the 32-bit range |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with the `TypeOrmModule.forFeature` wiring |
| `src/database/migrations.integration-spec.ts` | Integration | The three migrations apply and create all five tables; reverting the last one removes `videos` and its enum type |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with every column, the `videos_status_enum` type, the unique index on `slug` and the FK to `channels`
- Inserting two videos with the same `slug` fails with a unique constraint violation
- Inserting a video whose `channel_id` does not exist fails with a foreign-key violation
- A newly inserted video has `status = 'draft'`
- `npm run migration:revert` removes the `videos` table and the `videos_status_enum` type, and re-running `migration:run` recreates them

---

### SI-03.3 — Adaptador de object storage (S3/MinIO)

**Description:** Encapsulate every S3 interaction behind one injectable service: bucket bootstrap, the multipart lifecycle, presigning, ranged reads and derived-object writes. Nothing outside this module talks to the AWS SDK, so swapping MinIO for S3 in production stays a configuration change.

**Technical actions:**

- Create `src/storage/object-key.util.ts` — `buildSourceKey(videoId, filename)` and `buildThumbnailKey(videoId)` producing the `videos/{videoId}/source{ext}` and `thumbnails/{videoId}/thumbnail.jpg` layout of `phase-03-videos/TD-01`, with the extension taken from an allowlist and defaulted when the filename carries none
- Create `src/storage/storage.service.ts` — builds the `S3Client` with `forcePathStyle: true` against `storageConfig` (per `library-refs.md § @aws-sdk/client-s3`), and exposes `ensureBucket()` on `OnModuleInit`, `createMultipartUpload`, `presignUploadPart`, `completeMultipartUpload`, `abortMultipartUpload`, `putObject`, `headObject`, `getObjectRange`, `presignGetObject` and `deletePrefix`
- Create `src/storage/storage.module.ts` exporting `StorageService`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/object-key.util.spec.ts` | Unit | Key layout per video id, extension allowlist, default extension, path-traversal characters stripped from the filename |
| `src/storage/storage.service.integration-spec.ts` | Integration | Against real MinIO: bucket created on init and idempotent on re-init; a multipart upload of two parts completes and the object reads back byte-identical; `abortMultipartUpload` leaves no object; `getObjectRange` returns exactly the requested window and the reported total length; presigned part and GET URLs are executable with `fetch` |
| `src/storage/storage.module.spec.ts` | Unit | Module compiles and exports `StorageService` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Booting the module against an empty MinIO creates the configured bucket; booting again with the bucket present succeeds without error
- A two-part multipart upload completed through the service produces an object whose bytes equal the concatenated parts
- Aborting a started multipart upload leaves no object under the key
- `getObjectRange(key, 5, 9)` returns 5 bytes and reports the object's full length
- A presigned part URL uploads a chunk with a plain `PUT` carrying no credentials, and a presigned GET URL reads the object back

---

### SI-03.4 — Slug único de vídeo e resolução do canal do usuário

**Description:** Two small pieces every write endpoint needs: the generator behind the unique video URL, and the channel lookup identified as `DG-1` during validation. The lookup lives in `ChannelsService` so channel ownership stays inside `ChannelsModule`.

**Technical actions:**

- Create `src/videos/video-slug.util.ts` — `generateVideoSlug()` returning 11 URL-safe characters from `randomBytes(8).toString('base64url')` per `phase-03-videos/TD-07`
- Add `findByUserId(userId)` to `src/channels/channels.service.ts`, returning the channel or `null` (resolves `DG-1`)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/video-slug.util.spec.ts` | Unit | Always 11 characters, only the `base64url` alphabet, no two of a large sample collide |
| `src/channels/channels.service.integration-spec.ts` | Integration | `findByUserId` returns the channel created for a user and `null` for a user id with no channel |

**Dependencies:** SI-03.2

**Acceptance criteria:**

- `generateVideoSlug()` returns an 11-character string drawn only from `[A-Za-z0-9_-]`
- Ten thousand generated slugs contain no duplicate
- `ChannelsService.findByUserId` returns the channel of a registered user and `null` for an unknown user id

---

### SI-03.5 — Início do upload: rascunho automático e URLs de parte

**Description:** The write half of the upload handshake from `phase-03-videos/TD-03`. `POST /videos` validates the declared file, resolves the owner's channel, allocates a unique slug, opens the multipart upload and persists the video as `draft` — the automatic pre-registration the phase requires. A second endpoint hands out presigned part URLs in batches, and a third aborts an abandoned upload.

**Technical actions:**

- Create the request DTOs `src/videos/dto/create-video.dto.ts` (`title`, `filename`, `size_bytes`, `mime_type`) and `src/videos/dto/presign-parts.dto.ts` (`part_numbers`, 1..100 entries) with `class-validator` decorators only, per the inherited DTO convention
- Add the phase's domain exceptions to `src/common/exceptions/domain.exception.ts`: `VideoTooLargeException`, `UnsupportedVideoTypeException`, `ChannelNotFoundException`, `VideoNotFoundException`, `VideoUploadNotPendingException`, `VideoNotReadyException`, `InvalidRangeException`, `ThumbnailNotAvailableException` — codes and statuses per `## Technical Specifications → Error Catalog`
- Create `src/videos/videos.service.ts` with `createDraft(userId, dto)` — validate size against `video.maxUploadBytes` and mime against the allowlist, resolve the channel via `ChannelsService.findByUserId`, allocate a slug retrying on unique violation (the collision convention inherited from Fase 02), call `StorageService.createMultipartUpload`, and persist the `draft` row with `source_key` and `upload_id`
- Add `presignParts(userId, videoId, partNumbers)` and `abortUpload(userId, videoId)` to `VideosService` — both assert owner and `draft` status, the first returning one presigned URL per requested part, the second aborting the multipart upload and deleting the draft row
- Create `src/videos/videos.controller.ts` with `POST /videos`, `POST /videos/:id/uploads/parts` and `DELETE /videos/:id/uploads`, fully annotated with `@ApiTags`/`@ApiOperation`/`@ApiResponse` and the shared `ApiErrorEnvelope`; wire `VideosModule` to import `StorageModule` and `ChannelsModule`. The parts endpoint carries `@Throttle({ default: { limit: 60, ttl: 60000 } })` because a 10GB upload needs more part-URL batches than the global 10/min auth limit allows

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Branch logic with mocked collaborators: oversized declaration throws `VideoTooLargeException`, disallowed mime throws `UnsupportedVideoTypeException`, missing channel throws `ChannelNotFoundException`, slug collision retries with a fresh slug, a non-owner is rejected as not found |
| `src/videos/videos.service.integration-spec.ts` | Integration | Against real DB and MinIO: `createDraft` persists a `draft` row with slug, `source_key` and `upload_id`, and opens a real multipart upload; `abortUpload` removes the row and leaves no pending upload |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos` returns 201 with `slug` and the upload envelope; oversized/disallowed/invalid bodies return the documented codes; the endpoints reject an unauthenticated request with 401 and another user's video with 404 |

**Dependencies:** SI-03.3, SI-03.4

**Acceptance criteria:**

- `POST /videos` with a valid body returns `201` with `id`, `slug`, `status: "draft"` and an `upload` object carrying `upload_id`, `part_size` and `part_count`
- `POST /videos` persists the video as `draft` before a single byte has been uploaded
- `POST /videos` with `size_bytes` above 10 GiB returns `400` with `errorCode: "VIDEO_TOO_LARGE"`
- `POST /videos` with `mime_type: "application/pdf"` returns `415` with `errorCode: "UNSUPPORTED_VIDEO_TYPE"`
- `POST /videos/:id/uploads/parts` returns one presigned URL per requested part number, and a plain `PUT` to that URL uploads a chunk without credentials
- `DELETE /videos/:id/uploads` returns `204`, removes the draft, and a later `POST /videos/:id/uploads/complete` for it returns `404`
- Every endpoint returns `401` without a bearer token and `404` when the video belongs to another user

---

### SI-03.6 — Conclusão do upload e publicação do job de processamento

**Description:** Closes the handshake: the client reports its parts, the API completes the multipart upload, records the real object size, flips the video to `processing` and publishes one job on the queue. This is the boundary where `phase-03-videos/TD-02` and `phase-03-videos/TD-04` meet.

**Technical actions:**

- Create `src/videos/dto/complete-upload.dto.ts` — `parts` as a validated nested array of `{ part_number, etag }`, using `@ValidateNested` + `@Type` from `class-transformer`
- Register `BullModule.forRootAsync` in `AppModule` (connection from `queueConfig`) and `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })` in `VideosModule`, per `library-refs.md § @nestjs/bullmq`
- Add `completeUpload(userId, videoId, parts)` to `VideosService` — assert owner and `draft`, call `StorageService.completeMultipartUpload` with the parts sorted ascending, read the stored size with `headObject`, update the row to `processing` with the real `size_bytes`, clear `upload_id`, and enqueue `VIDEO_PROCESSING_JOB` with `jobId: video.id`, `attempts: video.processingAttempts` and exponential backoff
- Add `POST /videos/:id/uploads/complete` to `VideosController`, returning `202 Accepted` with `{ id, slug, status }` and the documented error responses

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Completing a video that is not `draft` throws `VideoUploadNotPendingException`; parts are forwarded sorted by part number; the job is enqueued with the video id as `jobId` |
| `src/videos/videos.service.integration-spec.ts` | Integration | Against real MinIO and real Redis: a two-part upload completes, the row moves to `processing` with the byte size read back from storage, and exactly one job lands on the `video-processing` queue |
| `test/videos.e2e-spec.ts` | E2E | The full handshake over HTTP — create, presign, `PUT` both parts, complete — returns `202` and leaves the video in `processing`; completing twice returns `409` |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- `POST /videos/:id/uploads/complete` with the uploaded parts returns `202` with `status: "processing"`
- After completion the stored `size_bytes` equals the number of bytes actually uploaded, not the value the client declared
- Completing an upload enqueues exactly one job on `video-processing`, keyed by the video id
- Calling complete a second time returns `409` with `errorCode: "VIDEO_UPLOAD_NOT_PENDING"`
- Completing an upload for a video owned by another user returns `404`

---

### SI-03.7 — Worker de vídeo: extração de metadados, thumbnail e status final

**Description:** The consumer side. A processing module wraps FFmpeg, reads the source through a short-lived presigned URL so a 10GB file never touches the worker's disk, writes duration, metadata and the thumbnail, and lands the video on `ready` or, once the retry budget is exhausted, on `failed` with a readable reason.

**Technical actions:**

- Create `src/videos/processing/ffmpeg.service.ts` — `probe(url)` running `ffprobe -v error -print_format json -show_format -show_streams` through `execFile` and parsing the JSON, and `extractThumbnail(url, atSeconds)` running `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale=640:-2 -q:v 2 -f image2 pipe:1` and returning the JPEG buffer (per `phase-03-videos/TD-06`)
- Create `src/videos/processing/video-processing.service.ts` — `process(videoId)`: load the video, presign a GET URL for `source_key`, probe it, compute the thumbnail position as `duration * video.thumbnailPositionRatio` clamped to at least 1s and below the duration, upload the JPEG to the thumbnail key, and persist `duration_seconds`, `metadata`, `thumbnail_key` and `status: ready`; `markFailed(videoId, reason)` persists `status: failed` with `processing_error`
- Create `src/videos/processing/video-processing.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` extending `WorkerHost`, delegating to the service, throwing `UnrecoverableError` when the video no longer exists, and calling `markFailed` from the `failed` event once `attemptsMade` reaches the configured budget
- Create `src/videos/processing/video-processing.module.ts` — `TypeOrmModule.forFeature([Video])`, `StorageModule`, the queue registration and the three providers
- Create `src/worker/worker.module.ts` (ConfigModule with the same namespaces and Joi schema, `TypeOrmModule.forRootAsync`, `BullModule.forRootAsync`, `VideoProcessingModule`) and `src/worker/main.worker.ts` bootstrapping it with `NestFactory.createApplicationContext` and `enableShutdownHooks`; add the `start:worker` npm script

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/processing/ffmpeg.service.integration-spec.ts` | Integration | Against real FFmpeg and a clip generated at test time with `-f lavfi -i testsrc`: `probe` returns the expected duration, dimensions and codec; `extractThumbnail` returns a non-empty buffer whose first bytes are the JPEG magic number; probing a non-video input rejects |
| `src/videos/processing/video-processing.service.integration-spec.ts` | Integration | Against real MinIO, DB and FFmpeg: processing a `processing` video writes duration, metadata, `thumbnail_key` and `status: ready`, and the thumbnail object exists in storage; `markFailed` records the reason and `status: failed` |
| `src/videos/processing/video-processing.processor.spec.ts` | Unit | A missing video raises `UnrecoverableError`; a job whose `attemptsMade` is below the budget rethrows so BullMQ retries; the last attempt marks the video `failed` |
| `src/worker/worker.module.spec.ts` | Unit | The worker module compiles as a standalone application context |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- Processing a completed upload sets `duration_seconds` to the clip's real duration and populates `metadata` with width, height and codec
- Processing writes a JPEG object at `thumbnails/{videoId}/thumbnail.jpg` and stores its key on the video
- A successfully processed video ends with `status = "ready"` and an empty `processing_error`
- A video whose source cannot be decoded ends with `status = "failed"` and a non-empty `processing_error` after the retry budget is exhausted
- A job whose video no longer exists is discarded without retrying

---

### SI-03.8 — Serviço `video-worker` no Docker Compose

**Description:** Ship the worker as its own container, as `phase-03-videos/TD-05` decided and the architecture diagram draws. Infrastructure only — the behavior it runs was delivered in SI-03.7.

**Technical actions:**

- Create `nestjs-project/Dockerfile.worker` — same Node base as `Dockerfile.dev` plus `ffmpeg`, running `npm run start:worker`
- Add the `video-worker` service to `nestjs-project/compose.yaml` — built from `Dockerfile.worker`, mounting the same source tree, depending on `db`, `redis` and `minio` being healthy, and carrying the same environment as `nestjs-api`

**Tests:** _(empty — Infra; the worker behavior is covered by SI-03.7 and the end-to-end path by SI-03.10)_

**Dependencies:** SI-03.7

**Acceptance criteria:**

- `docker compose up -d` starts `video-worker` and it stays running
- `docker compose logs video-worker` shows the Nest application context bootstrapping with no unresolved-dependency error
- `ffprobe -version` succeeds inside the `video-worker` container

---

### SI-03.9 — Endpoints de leitura: metadados e thumbnail

**Description:** Make the unique URL resolve to something. One read-only metadata endpoint keyed by the slug — the answer recorded for `AMB-2` — plus the route that serves the generated thumbnail, which is otherwise unreachable because the bucket is private.

**Technical actions:**

- Create `src/videos/dto/video-response.dto.ts` — a response DTO with explicit `@ApiProperty` on every field (`id`, `slug`, `title`, `status`, `duration_seconds`, `size_bytes`, `mime_type`, `original_filename`, `metadata`, `processing_error`, `created_at`, `updated_at`), per the inherited response-DTO convention
- Add `findBySlugForOwner(userId, slug)` to `VideosService`, throwing `VideoNotFoundException` both when the slug is unknown and when the video belongs to another channel so existence is not leaked
- Add `readThumbnail(userId, slug)` to `VideosService`, throwing `ThumbnailNotAvailableException` while `thumbnail_key` is null
- Add `GET /videos/:slug` and `GET /videos/:slug/thumbnail` to `VideosController`, the second streaming the object with `Content-Type: image/jpeg`, with full OpenAPI annotations

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `findBySlugForOwner` raises `VideoNotFoundException` for an unknown slug and for a slug owned by another channel; `readThumbnail` raises `ThumbnailNotAvailableException` before processing completes |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/:slug` returns the documented shape and reflects the `draft → processing → ready` transition; `GET /videos/:slug/thumbnail` returns `200` with `image/jpeg` after processing and `404` before it |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- `GET /videos/:slug` returns `200` with the documented body, including the current `status`
- `GET /videos/:slug` for a slug that does not exist returns `404` with `errorCode: "VIDEO_NOT_FOUND"`
- `GET /videos/:slug` for a video owned by another user returns `404`, identical to the unknown-slug response
- `GET /videos/:slug/thumbnail` returns `200` with `Content-Type: image/jpeg` once the video is `ready`
- `GET /videos/:slug/thumbnail` on a video still processing returns `404` with `errorCode: "THUMBNAIL_NOT_AVAILABLE"`

---

### SI-03.10 — Streaming com `Range` e download

**Description:** The delivery half of the phase. The API answers `Range` with `206 Partial Content` so playback starts without downloading the file, and a second route serves the same object as an attachment. Both keep authorization per request, as `phase-03-videos/TD-08` and `phase-03-videos/TD-09` decided.

**Technical actions:**

- Create `src/videos/range.util.ts` — `parseRangeHeader(header, totalSize)` returning the resolved `{ start, end }`, `null` when the header is absent, and a sentinel for an unsatisfiable range so the controller can answer `416`
- Add `openStream(userId, slug, rangeHeader)` to `VideosService` — resolve the owner's `ready` video (throwing `VideoNotReadyException` otherwise), `headObject` for the total size, parse the range, and return the storage stream plus the headers the controller must set
- Add `GET /videos/:slug/stream` to `VideosController` — `206` with `Content-Range`, `Accept-Ranges: bytes` and `Content-Length` when a range is given, `200` with `Accept-Ranges: bytes` otherwise, `416` with `Content-Range: bytes */<size>` when unsatisfiable
- Add `GET /videos/:slug/download` to `VideosController` — `200` streaming the whole object with `Content-Disposition: attachment; filename="<title>.<ext>"` and the stored `Content-Type`
- Extend `test/videos.e2e-spec.ts` so the E2E testing module imports `VideoProcessingModule` alongside `AppModule`, letting the real BullMQ worker consume from the real queue in-process and making the full `create → upload → complete → ready` path assertable

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/range.util.spec.ts` | Unit | Absent header, `bytes=0-`, `bytes=10-19`, open-ended suffix `bytes=-100`, out-of-bounds start, malformed header |
| `test/videos.e2e-spec.ts` | E2E | The complete lifecycle ending in `ready`; `Range: bytes=0-99` returns `206` with 100 bytes and the correct `Content-Range`; a request with no range returns `200` with `Accept-Ranges: bytes`; an unsatisfiable range returns `416`; download returns the whole object with the attachment header; streaming a video that is not `ready` returns `409` |

**Dependencies:** SI-03.9

**Acceptance criteria:**

- `GET /videos/:slug/stream` with `Range: bytes=0-99` returns `206`, exactly 100 bytes, `Content-Range: bytes 0-99/<size>` and `Accept-Ranges: bytes`
- `GET /videos/:slug/stream` without a `Range` header returns `200` with `Accept-Ranges: bytes` and the full `Content-Length`
- `GET /videos/:slug/stream` with a range beyond the object size returns `416` with `Content-Range: bytes */<size>`
- `GET /videos/:slug/stream` on a video that is not `ready` returns `409` with `errorCode: "VIDEO_NOT_READY"`
- `GET /videos/:slug/download` returns `200` with `Content-Disposition: attachment` and a body byte-identical to the uploaded file
- A video created through the API reaches `status: "ready"` without any manual step once its upload is completed

---

### SI-03.11 — Documentação de IA, diagrama e OpenAPI

**Description:** Bring the AI foundation and the exported contract in line with the code this phase shipped: the queue is no longer `TBD`, the stack has an object store and a worker container, and the API exposes a videos surface.

**Technical actions:**

- Update the root `CLAUDE.md` — name BullMQ over Redis as the queue and MinIO/S3 as the object storage in the architecture section, and add a videos section describing the module, the endpoints, the upload handshake and the worker
- Update `nestjs-project/CLAUDE.md` — the new Compose services, the `video-worker` container and its commands, the FFmpeg requirement, and the videos module layout
- Update `docs/diagrams/software-arch.mermaid` — replace the `TBD` message-queue technology with `Redis / BullMQ`
- Regenerate `nestjs-project/openapi.json` with `npm run openapi:export`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/openapi-export.integration-spec.ts` | Integration | The exported document includes every videos path and the `videos` tag |

**Dependencies:** SI-03.10

**Acceptance criteria:**

- The root `CLAUDE.md` architecture section names the queue technology chosen in this phase and no longer says `TBD`
- `nestjs-project/CLAUDE.md` documents `minio`, `redis` and `video-worker` and the command that runs the worker
- `docs/diagrams/software-arch.mermaid` names the queue technology
- `openapi.json` contains all eight videos paths under the `videos` tag

---

### SI-03.12 — Correções da revisão de código e segurança (amendment)

**Description:** Amendment SI closing the findings raised by the `code-reviewer` and `security-auditor` passes over the completed phase. It changes no contract except adding the `INVALID_UPLOAD_PART` error and the RFC 6266 `Content-Disposition` form; every other change hardens behavior that was already specified.

**Technical actions:**

- Replace the raw `readable.pipe(response)` in the thumbnail, stream and download handlers with a `node:stream/promises` `pipeline` helper (`src/videos/stream-response.util.ts`): an unhandled `error` on the storage stream was an `uncaughtException` that would take the API process down, and a client disconnect leaked the upstream storage socket
- Constrain `ffprobe` and `ffmpeg` to `https,tls,tcp,http` via `-protocol_whitelist` and add process timeouts plus `-rw_timeout`: the source bytes are attacker-controlled, and an HLS or concat "video" whose entries point at `file://` or an internal endpoint would otherwise be dereferenced by the worker
- Bound the part numbers `POST /videos/:id/uploads/parts` will presign to `ceil(size_bytes / part_size)` for that draft (new `InvalidUploadPartException`), and reject at completion when the bytes actually stored exceed the maximum — the size limit was only checked against the client's declaration
- Claim the `draft → processing` transition with one conditional `UPDATE` so two concurrent completions produce a deterministic `409`; hand the draft back when the storage completion fails, and mark the video `failed` when the processing job cannot be enqueued instead of stranding it in `processing`
- Emit `Content-Disposition` in the RFC 6266 form (`filename` ASCII fallback + `filename*=UTF-8''…`), because a title outside Latin-1 made `setHeader` throw mid-response

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Part numbers beyond the draft's part count are refused; the loser of a concurrent completion gets 409; a failed storage completion returns the video to `draft`; oversized stored bytes discard the object and mark the video failed; an enqueue failure marks the video failed |
| `src/videos/processing/ffmpeg.service.integration-spec.ts` | Integration | Probing and thumbnailing read the source over HTTP; a playlist embedding a `file://` reference is refused by the protocol whitelist |
| `src/videos/download-filename.util.spec.ts` | Unit | Non-Latin-1 titles are dropped from the ASCII fallback, preserved in the UTF-8 form, and the emitted header carries no CR/LF |
| `test/videos.e2e-spec.ts` | E2E | The parts endpoint returns `400 INVALID_UPLOAD_PART` past the declared part count; download returns the RFC 6266 header |

**Dependencies:** SI-03.11

**Acceptance criteria:**

- A storage failure mid-stream does not terminate the API process, and a client disconnect destroys the upstream storage stream
- `ffprobe` on a playlist whose segment is `file:///etc/passwd` fails instead of reading the file
- `POST /videos/:id/uploads/parts` with a part number above `ceil(size_bytes / part_size)` returns `400` with `errorCode: "INVALID_UPLOAD_PART"`
- Completing an upload whose stored bytes exceed the maximum returns `400 VIDEO_TOO_LARGE`, removes the stored object and leaves the video `failed`
- Two concurrent completions of the same upload produce exactly one `202` and one `409`
- A video whose processing job cannot be enqueued ends `failed` with a reason, never stuck in `processing`
- `GET /videos/:slug/download` of a video whose title is outside Latin-1 returns `200` with a valid `Content-Disposition`

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | |
| slug | varchar(16) | unique, not null | 11-character `base64url` public identifier (`phase-03-videos/TD-07`) |
| channel_id | uuid | FK → channels.id, not null | Owning channel; resolved from the authenticated user |
| title | varchar(120) | not null | Supplied at draft creation |
| status | enum | not null, default `'draft'` | `videos_status_enum`: `draft`, `processing`, `ready`, `failed` (`phase-03-videos/TD-04`) |
| source_key | varchar(512) | not null | `videos/{id}/source{ext}` (`phase-03-videos/TD-01`) |
| thumbnail_key | varchar(512) | nullable | `thumbnails/{id}/thumbnail.jpg`; written by the worker |
| upload_id | varchar(255) | nullable | S3 multipart `UploadId` while the video is `draft`; cleared on complete or abort |
| size_bytes | bigint | not null | Client-declared at creation, overwritten with the stored size on complete. Read through a transformer so the driver's string becomes a number |
| mime_type | varchar(100) | not null | Declared content type, validated against the allowlist |
| original_filename | varchar(255) | not null | Used for the download filename and the storage extension |
| duration_seconds | integer | nullable | Written by the worker from `ffprobe` |
| metadata | jsonb | nullable | Written by the worker: `width`, `height`, `video_codec`, `audio_codec`, `bit_rate`, `format_name`, `frame_rate` |
| processing_error | text | nullable | Populated when `status = 'failed'` |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, owning side via `channel_id`); Channel → Video (one-to-many)
**Indexes:** `(slug)` — unique; `(channel_id)` — FK lookups for owner checks

---

### API Contracts

All routes live under `@Controller('videos')`. Write routes are keyed by `id` (the internal uuid, held by the uploading client for the duration of the handshake); read routes are keyed by `slug` (the public identifier from `phase-03-videos/TD-07`).

#### POST /videos (SI-03.5)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer &lt;access_token&gt;

**Request body:**
- title: string, required — 1 to 120 characters
- filename: string, required — 1 to 255 characters
- size_bytes: integer, required — 1 to 10737418240 (10 GiB)
- mime_type: string, required — one of the configured allowlist

**Response 201:**
- id: string (uuid)
- slug: string (11 characters)
- status: string — always `"draft"`
- upload: object — `upload_id` (string), `part_size` (integer, bytes), `part_count` (integer)

**Error responses:**
- 400 VIDEO_TOO_LARGE: when `size_bytes` exceeds the configured maximum
- 415 UNSUPPORTED_VIDEO_TYPE: when `mime_type` is not in the allowlist
- 404 CHANNEL_NOT_FOUND: when the authenticated user has no channel
- 400 validation error: when the request body fails schema validation
- 401: when the access token is missing or invalid

---

#### POST /videos/{id}/uploads/parts (SI-03.5)

Returns one presigned `UploadPart` URL per requested part number. Called repeatedly in batches while the client uploads; carries a dedicated throttle allowance because a 10 GiB upload needs more batches than the global auth limit permits.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer &lt;access_token&gt;

**Request body:**
- part_numbers: integer[], required — 1 to 100 entries, each between 1 and 10000

**Response 200:**
- parts: array of `{ part_number: integer, url: string, expires_in: integer }`

**Error responses:**
- 400 INVALID_UPLOAD_PART: when a requested part number exceeds `ceil(size_bytes / part_size)` for this upload
- 409 VIDEO_UPLOAD_NOT_PENDING: when the video is no longer `draft`
- 404 VIDEO_NOT_FOUND: when the id is unknown or the video belongs to another channel
- 400 validation error: when the body fails schema validation
- 401: when the access token is missing or invalid

---

#### POST /videos/{id}/uploads/complete (SI-03.6)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer &lt;access_token&gt;

**Request body:**
- parts: array, required — at least one `{ part_number: integer, etag: string }`

**Response 202:**
- id: string (uuid)
- slug: string
- status: string — always `"processing"`

**Error responses:**
- 400 VIDEO_TOO_LARGE: when the bytes actually stored exceed the maximum; the object is discarded and the video is marked `failed`
- 409 VIDEO_UPLOAD_NOT_PENDING: when the video is no longer `draft`, including the loser of two concurrent completions
- 404 VIDEO_NOT_FOUND: when the id is unknown or the video belongs to another channel
- 400 validation error: when the body fails schema validation
- 401: when the access token is missing or invalid

---

#### DELETE /videos/{id}/uploads (SI-03.5)

Aborts an in-flight multipart upload and discards the draft.

**Request headers:**
- Authorization: Bearer &lt;access_token&gt;

**Response 204:** No content.

**Error responses:**
- 409 VIDEO_UPLOAD_NOT_PENDING: when the video is no longer `draft`
- 404 VIDEO_NOT_FOUND: when the id is unknown or the video belongs to another channel
- 401: when the access token is missing or invalid

---

#### GET /videos/{slug} (SI-03.9)

**Request headers:**
- Authorization: Bearer &lt;access_token&gt;

**Response 200:**
- id, slug, title, status, mime_type, original_filename: string
- size_bytes, duration_seconds: integer — `duration_seconds` is null until processing completes
- metadata: object, nullable
- processing_error: string, nullable
- created_at, updated_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the slug is unknown or the video belongs to another channel
- 401: when the access token is missing or invalid

---

#### GET /videos/{slug}/thumbnail (SI-03.9)

**Request headers:**
- Authorization: Bearer &lt;access_token&gt;

**Response 200:** the JPEG bytes, `Content-Type: image/jpeg`.

**Error responses:**
- 404 THUMBNAIL_NOT_AVAILABLE: when the video has no thumbnail yet
- 404 VIDEO_NOT_FOUND: when the slug is unknown or the video belongs to another channel
- 401: when the access token is missing or invalid

---

#### GET /videos/{slug}/stream (SI-03.10)

**Request headers:**
- Authorization: Bearer &lt;access_token&gt;
- Range: bytes=&lt;start&gt;-&lt;end&gt; — optional

**Response 206:** the requested byte window, with `Content-Range: bytes <start>-<end>/<total>`, `Accept-Ranges: bytes`, `Content-Length` equal to the window size and the stored `Content-Type`.

**Response 200:** the whole object when no `Range` header is present, with `Accept-Ranges: bytes`.

**Error responses:**
- 416 INVALID_RANGE: when the range cannot be satisfied; the response carries `Content-Range: bytes */<total>`
- 409 VIDEO_NOT_READY: when the video is not `ready`
- 404 VIDEO_NOT_FOUND: when the slug is unknown or the video belongs to another channel
- 401: when the access token is missing or invalid

---

#### GET /videos/{slug}/download (SI-03.10)

**Request headers:**
- Authorization: Bearer &lt;access_token&gt;

**Response 200:** the whole object, with `Content-Disposition: attachment; filename="<title>.<ext>"`, `Content-Length` and the stored `Content-Type`.

**Error responses:**
- 409 VIDEO_NOT_READY: when the video is not `ready`
- 404 VIDEO_NOT_FOUND: when the slug is unknown or the video belongs to another channel
- 401: when the access token is missing or invalid

---

#### Validation Rules — Video creation and upload completion

| Field | Rule | Error message |
|-------|------|---------------|
| title | Required string, 1 to 120 characters | title must be longer than or equal to 1 characters |
| filename | Required string, 1 to 255 characters | filename must be longer than or equal to 1 characters |
| size_bytes | Required integer, minimum 1 | size_bytes must not be less than 1 |
| size_bytes | Maximum 10737418240 (domain rule, `VIDEO_TOO_LARGE`) | Video exceeds the maximum allowed size |
| mime_type | Required string in the configured allowlist (domain rule, `UNSUPPORTED_VIDEO_TYPE`) | Video type is not supported |
| part_numbers | Required array, 1 to 100 integers between 1 and 10000 | part_numbers must contain at least 1 elements |
| parts | Required array of `{ part_number, etag }`, at least one entry | parts must contain at least 1 elements |

---

### Authorization Matrix

Every route in this phase is owner-only: the global `JwtAuthGuard` requires a valid access token and the service authorizes the video against the channel of the authenticated user. No route carries `@Public()`. This is the answer recorded for `AMB-1` in `validation.md`: Phase 03 has no visibility vocabulary — `público` / `unlisted` arrive in Fase 04 and anonymous viewing in Fase 05 — so opening any route now would encode a rule this phase cannot express.

| Endpoint | Anonymous | Authenticated (not owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ (401) | ✓ (creates in own channel) | ✓ |
| POST /videos/{id}/uploads/parts | ✗ (401) | ✗ (404) | ✓ |
| POST /videos/{id}/uploads/complete | ✗ (401) | ✗ (404) | ✓ |
| DELETE /videos/{id}/uploads | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/{slug} | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/{slug}/thumbnail | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/{slug}/stream | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/{slug}/download | ✗ (401) | ✗ (404) | ✓ |

A non-owner receives `404`, never `403`: the two responses are byte-identical to the unknown-slug case so existence is not disclosed.

---

### Error Catalog

**Error response format:** inherited from `phase-02-auth/TD-07` — `{ statusCode, error, message }`, where `error` carries the domain code below and `DomainExceptionFilter` performs the mapping.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_TOO_LARGE | 400 | POST /videos with `size_bytes` above the configured maximum |
| UNSUPPORTED_VIDEO_TYPE | 415 | POST /videos with a `mime_type` outside the allowlist |
| CHANNEL_NOT_FOUND | 404 | POST /videos when the authenticated user has no channel |
| VIDEO_NOT_FOUND | 404 | Any route addressing a video that does not exist or belongs to another channel |
| INVALID_UPLOAD_PART | 400 | Part presigning for a part number beyond what the declared size allows |
| VIDEO_UPLOAD_NOT_PENDING | 409 | Part presigning, completion or abort on a video that is no longer `draft` |
| VIDEO_NOT_READY | 409 | Stream or download on a video whose status is not `ready` |
| THUMBNAIL_NOT_AVAILABLE | 404 | GET thumbnail before the worker has produced one |
| INVALID_RANGE | 416 | A `Range` header that cannot be satisfied for the object size |

---

### Events/Messages

#### process-video

**Queue:** `video-processing` (BullMQ over Redis, per `phase-03-videos/TD-02`)

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService.completeUpload` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`)
**Consumer:** `VideoProcessor` running inside the `video-worker` container (per `phase-03-videos/TD-05`)
**Trigger:** the multipart upload has been completed and the video moved to `processing`.
**Job options:** `jobId` is the video id, so a repeated completion cannot enqueue the same work twice; `attempts` comes from `VIDEO_PROCESSING_ATTEMPTS` (default 3) with exponential backoff from 2000ms; `removeOnComplete: true`.
**Delivery semantics:** at-least-once. The consumer is idempotent — it recomputes duration, metadata and the thumbnail from the source object and overwrites the same columns and the same storage key, so a redelivery converges to the same state.
**Failure handling:** a thrown error is retried while attempts remain; `UnrecoverableError` skips the remaining budget (used when the video row no longer exists). Once the budget is exhausted the consumer writes `status: failed` with `processing_error`, which is terminal for this phase (per `phase-03-videos/TD-04`).

---

## Dependency Map

```
SI-03.1 (root — deps, config, minio + redis)
├── SI-03.2 — depends on SI-03.1 (config namespaces must exist before the entity module)
│   └── SI-03.4 — depends on SI-03.2 (slug util and channel lookup serve the videos entity)
└── SI-03.3 — depends on SI-03.1 (storage config)

SI-03.3 + SI-03.4
└── SI-03.5 — draft creation, part presigning, abort
    └── SI-03.6 — upload completion + queue producer
        ├── SI-03.7 — worker: ffmpeg, processor, standalone context
        │   └── SI-03.8 — video-worker service in Compose
        └── SI-03.9 — metadata and thumbnail endpoints
            └── SI-03.10 — streaming with Range and download
                └── SI-03.11 — CLAUDE.md, diagram and OpenAPI
```

Linearized implementation order: SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12

---

## Deliverables

- [ ] SI-03.1 — Dependências, namespaces de configuração e serviços de infraestrutura
- [ ] SI-03.2 — Entidade Video, migration e módulo
- [ ] SI-03.3 — Adaptador de object storage (S3/MinIO)
- [ ] SI-03.4 — Slug único de vídeo e resolução do canal do usuário
- [ ] SI-03.5 — Início do upload: rascunho automático e URLs de parte
- [ ] SI-03.6 — Conclusão do upload e publicação do job de processamento
- [ ] SI-03.7 — Worker de vídeo: extração de metadados, thumbnail e status final
- [ ] SI-03.8 — Serviço `video-worker` no Docker Compose
- [ ] SI-03.9 — Endpoints de leitura: metadados e thumbnail
- [ ] SI-03.10 — Streaming com `Range` e download
- [ ] SI-03.11 — Documentação de IA, diagrama e OpenAPI
- [ ] SI-03.12 — Correções da revisão de código e segurança (amendment)

**Phase capabilities:**

- [ ] Object storage for video files and thumbnails, reachable only through the API
- [ ] Background processing queue with a worker consuming it
- [ ] Upload of files up to 10GB that never traverse the API process
- [ ] Video pre-registered as a draft the moment the upload starts
- [ ] Automatic processing after upload: duration and metadata extracted
- [ ] Thumbnail generated automatically from a frame of the video
- [ ] Unique, collision-free URL identifier per video
- [ ] Streaming playback via `Range` / `206 Partial Content`
- [ ] Video download available to the owner
- [ ] Video status cycle `draft → processing → ready | failed` persisted in the database
- [ ] `minio`, `redis` and `video-worker` running via `docker compose up -d` alongside the existing stack
- [ ] Migration creating the `videos` table, linked to `channels`

**Full test suites:**

- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
