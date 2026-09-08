# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 4/11 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Conclusão do upload e publicação do job de processamento
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Worker de vídeo: extração de metadados, thumbnail e status final
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Serviço video-worker no Docker Compose
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Endpoints de leitura: metadados e thumbnail
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Streaming com Range e download
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Documentação de IA, diagrama e OpenAPI
- **Status:** pending
- **Tests:** —
- **Observations:** none
