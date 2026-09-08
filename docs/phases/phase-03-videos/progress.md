# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 10/11 completed

### SI-03.1 — Dependências, namespaces de configuração e serviços de infraestrutura
- **Status:** completed
- **Tests:** 10/10 passing (env.validation.integration-spec.ts)
- **Observations:**
  - `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` are Joi-required, so the pre-existing `requiredEnv` fixture in the env spec had to be extended or every prior case would fail.
  - `ffmpeg` was added to `Dockerfile.dev` as well as the future worker image: the suite runs inside `nestjs-api`, and `phase-03-videos/TD-10` requires the real toolchain in integration tests.
  - MinIO healthcheck uses `mc ready local`, which ships in the current `minio/minio` image.

### SI-03.2 — Entidade Video, migration e módulo
- **Status:** completed
- **Tests:** 159/159 passing suite-wide (video.entity.integration-spec.ts: 8, videos.module.spec.ts: 1, migrations.integration-spec.ts: 2)
- **Observations:**
  - Adding `@OneToMany(() => Video)` to `Channel` made every existing test DataSource fail with "Entity metadata for Channel#videos was not found" — TypeORM resolves relations eagerly, so an entity list missing `Video` breaks specs that never touch videos. Extracted the canonical list to `ALL_ENTITIES` in `src/test/create-test-data-source.ts` and pointed all ten specs at it, removing the duplicated local constant.
  - `size_bytes` is `bigint` because 10GiB overflows int4; the driver returns it as a string, so the column carries a transformer that narrows to `number` at the entity boundary.
  - `cleanAllTables` deletes `videos` before `channels` to respect the new foreign key.

### SI-03.3 — Adaptador de object storage (S3/MinIO)
- **Status:** completed
- **Tests:** 16/16 passing (object-key.util.spec.ts: 8, storage.module.spec.ts: 1, storage.service.integration-spec.ts: 7 against real MinIO)
- **Observations:**
  - The integration spec uploads a real 5MiB first part: S3 and MinIO both reject `CompleteMultipartUpload` with `EntityTooSmall` when a non-final part is under 5MiB, so a token-sized fixture would not exercise the real path.
  - `GetObjectCommand` types `Body` as a runtime union; on Node it is always a `Readable`, so the cast is confined to `StorageService.getObjectRange` and never leaks to callers.
  - `presignUploadPart` deliberately omits `ContentType` — S3 signs it into the URL and the client would have to reproduce the header byte-for-byte; the content type belongs on `CreateMultipartUpload`.

### SI-03.4 — Slug único de vídeo e resolução do canal do usuário
- **Status:** completed
- **Tests:** 8/8 passing (video-slug.util.spec.ts: 3, channels.service.integration-spec.ts: 5 including the two new findByUserId cases)
- **Observations:**
  - `findByUserId` went into `ChannelsService` rather than the videos module, which is the resolution recorded for `DG-1` in validation.md — channel ownership stays behind the channels boundary.

### SI-03.5 — Início do upload: rascunho automático e URLs de parte
- **Status:** completed
- **Tests:** 23/23 passing (videos.service.spec.ts: 10 unit, videos.service.integration-spec.ts: 4 against real DB + MinIO, videos.e2e-spec.ts: 9)
- **Observations:**
  - `test/jest-e2e.json` had no worker limit, so e2e specs ran in parallel against the shared database. A fourth data-writing spec made the race visible and broke `auth.e2e-spec.ts` too. Added `maxWorkers: 1`, which is what `nestjs-project/CLAUDE.md` already claimed was configured.
  - The video id is generated with `randomUUID()` before the insert so the storage key is deterministic and the multipart upload can be opened before the row exists.
  - `createDraft` aborts the multipart upload when the insert fails; otherwise an open upload would linger in storage with no row pointing at it.
  - The unique-violation predicate moved from `ChannelsService` to `src/common/database/pg-error.util.ts` so the slug retry and the nickname retry share one implementation instead of duplicating a subtle driver-error check.
  - The parts endpoint carries its own `@Throttle` allowance: the global 10 req/min auth limit cannot accommodate the batches a 10GiB upload needs.

### SI-03.6 — Conclusão do upload e publicação do job de processamento
- **Status:** completed
- **Tests:** 199 unit/integration + 64 e2e passing (videos.service.spec.ts: 14 unit, videos.service.integration-spec.ts: 5 against real MinIO + Redis, videos.e2e-spec.ts: 12)
- **Observations:**
  - `@nestjs/bullmq@12.0.0` declares `"type": "module"` and points its `require` condition at the same ESM entry, so ts-jest failed with `SyntaxError: Unexpected token 'export'`. Pinned the CommonJS 11.x line with `bullmq@^5.81.4`; recorded as a Revision on `phase-03-videos/TD-02` and propagated to context.md and library-refs.md. Same Option A, different pins.
  - The integration test pauses the queue around the completion so the "exactly one waiting job" assertion cannot race the worker container that will consume the same Redis from SI-03.8 onward.
  - `size_bytes` is overwritten from `headObject` after completion — the value the client declared is an input to validation, not a fact.

### SI-03.7 — Worker de vídeo: extração de metadados, thumbnail e status final
- **Status:** completed
- **Tests:** 23/23 passing (ffmpeg.service.integration-spec.ts: 4 against real FFmpeg, thumbnail-position.util.spec.ts: 5, video-processing.service.integration-spec.ts: 6 against real MinIO + DB + FFmpeg, video-processing.processor.spec.ts: 7, worker.module.spec.ts: 1)
- **Observations:**
  - `WorkerModule` failed to build TypeORM metadata with "Entity metadata for Video#channel was not found": `autoLoadEntities` only sees entities registered by imported modules, and the worker imported none of the channel/user modules. Importing `UsersModule` closes the `Video -> Channel -> User` graph. Without this the worker container would have crashed on boot.
  - The retry decision moved out of `process()` into an `@OnWorkerEvent('failed')` handler: `attemptsMade` semantics inside the processor differ across BullMQ versions, while the failed event always carries the post-failure count.
  - The test fixture is generated by FFmpeg (`testsrc` + `sine`) at test time, so no binary artifact enters the repository and the real decoder path is exercised.
  - `ffprobe` and `ffmpeg` read the source through a presigned URL over HTTP range requests — the integration test confirms processing completes with nothing written to the worker's disk.

### SI-03.8 — Serviço video-worker no Docker Compose
- **Status:** completed
- **Tests:** no tests (Infra) — suite stayed green with the worker container competing for the same queue: 222 unit/integration + 64 e2e
- **Observations:**
  - The worker image is separate from the API image: only the worker needs FFmpeg in production, and the API should not carry the transcoding toolchain.
  - With the worker running, the "exactly one waiting job" integration assertion only holds because that test pauses the queue around the completion.

### SI-03.9 — Endpoints de leitura: metadados e thumbnail
- **Status:** completed
- **Tests:** 225 unit/integration + 70 e2e passing (videos.service.spec.ts: 17, videos.e2e-spec.ts: 18 including the full create -> upload -> complete -> ready -> thumbnail path)
- **Observations:**
  - Pulled the plan's SI-03.10 action that imports `VideoProcessingModule` into the e2e testing module forward to this SI: the thumbnail assertion needs a genuinely processed video, and running the real BullMQ worker in-process makes the automatic pipeline observable without depending on the worker container being up.
  - The e2e uploads the generated clip as a single part — S3 enforces the 5MiB floor only on parts that are not the last one, so a real 42KB clip is a valid one-part upload.
  - `fetch` rejects `Buffer<ArrayBufferLike>` in its BodyInit union; the clip is passed as a `Uint8Array` view.

### SI-03.10 — Streaming com Range e download
- **Status:** completed
- **Tests:** 241 unit/integration + 78 e2e passing (range.util.spec.ts: 11, download-filename.util.spec.ts: 5, videos.e2e-spec.ts: 26)
- **Observations:**
  - RFC 9110 requires `Content-Range: bytes */<size>` on a 416, which the generic domain-exception filter had no way to emit. `DomainException` now carries an optional headers map and the filter applies it — additive and backward compatible for every existing exception.
  - A `Range` header that cannot be parsed is ignored and the whole object is served, per RFC 9110; only a syntactically valid range outside the object produces 416.
  - The download filename is derived from the title with quotes, backslashes, separators and control characters stripped, falling back to the slug — it lands inside a quoted `Content-Disposition` value.

### SI-03.11 — Documentação de IA, diagrama e OpenAPI
- **Status:** pending
- **Tests:** —
- **Observations:** none
