# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 2/11 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Slug único de vídeo e resolução do canal do usuário
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
