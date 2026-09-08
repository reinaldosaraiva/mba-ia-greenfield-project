---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-09-08
scope_description: "Backend foundation for video upload and processing: object storage layout, background job queue, 10GB direct-to-storage upload, video worker runtime, FFmpeg metadata/thumbnail extraction, unique video URL, streaming and download delivery, and the video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (draft pre-registration, upload handshake, streaming, download), the object-storage adapter, the job queue producer, and the video worker that consumes it. Also owns the new Compose services (object storage, queue broker, worker).
- `next-frontend/` — Frontend deferred: Phase 03 has no UI capability bullet (`docs/project-plan.md` Fase 03 lists no `Tela`/`Página` item; the player screen belongs to Fase 05 — `Página de Visualização do Vídeo`). No open decision in this document.

---

## TD-01: Object Storage Client and Bucket/Key Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage backend itself is not open — `docs/diagrams/software-arch.mermaid` already fixes `Object Storage (S3 or MinIO)`, and MinIO is the local Docker stand-in for S3. What is open is *how* the project talks to it: which client library, and how buckets and object keys are laid out. The key layout is a cross-component contract — the API writes it, the worker reads and writes it, and every future phase (Fase 04 custom thumbnails, Fase 05 player) resolves objects through it.

**Options:**

### Option A: `@aws-sdk/client-s3` v3 + `@aws-sdk/s3-request-presigner`, single bucket with per-entity prefixes
- The official AWS SDK v3 modular client, pointed at MinIO via `endpoint` + `forcePathStyle: true`. One bucket (`streamtube`) holds everything; keys are namespaced by prefix: `videos/{videoId}/source{ext}` and `thumbnails/{videoId}/thumbnail.jpg`.
- **Pros:** Zero migration cost to real S3 in production (same API, only `endpoint`/credentials change). Presigner package is the only supported way to issue presigned multipart part URLs, which TD-03 depends on. One bucket means one lifecycle/policy surface and one bootstrap step. Prefix-per-entity keeps every artifact of a video co-located, so deleting a video is a prefix delete.
- **Cons:** Larger dependency surface than a minimal S3 client. Bucket-level policies cannot differ between videos and thumbnails (e.g., making thumbnails public while keeping sources private requires a prefix policy, not a bucket policy).

### Option B: `minio` JS client, bucket-per-entity (`videos`, `thumbnails`)
- MinIO's own SDK, with two buckets separating source files from derived thumbnails.
- **Pros:** Slightly simpler API for basic put/get. Bucket-per-entity allows independent policies and quotas.
- **Cons:** Ties the code to MinIO's client; swapping to S3 in production means rewriting the adapter, contradicting the architecture diagram's `S3 or MinIO` intent. Two buckets means two bootstrap steps and a two-place delete for one logical entity. Multipart presigning support is weaker than the AWS presigner.

### Option C: `@aws-sdk/client-s3` v3, bucket-per-entity
- AWS SDK with two buckets.
- **Pros:** Keeps S3 portability while allowing per-bucket policy.
- **Cons:** Buys the policy flexibility Phase 03 does not need (nothing is public in this phase — TD-08 keeps delivery behind the API) at the cost of a second bootstrap path and a split delete. Premature.

**Recommendation:** **Option A** — `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, single bucket with `videos/{videoId}/…` and `thumbnails/{videoId}/…` prefixes. The presigner is a hard requirement of TD-03's upload handshake, and the single-bucket prefix layout makes a video's whole footprint addressable by one prefix. Per-entity buckets can be introduced later without touching the stored keys, because the key already carries the entity namespace.

**Decision:** _[pending]_

---

## TD-02: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/project-plan.md` and `docs/diagrams/software-arch.mermaid` both leave the queue explicitly `TBD`. This is the main stack decision of the phase: the API publishes one job per finished upload, and a separate worker consumes it. The choice determines the broker container in Compose, the retry/backoff semantics, and how failures surface back into the video status lifecycle (TD-04).

**Options:**

### Option A: BullMQ over Redis (`bullmq` + `@nestjs/bullmq`)
- Redis-backed queue with an official NestJS integration. The API injects a `Queue` and calls `add()`; the worker declares a `@Processor` class extending `WorkerHost`. Retries with exponential backoff, per-job attempts, delayed jobs, concurrency limits, and a failed-jobs set are built in.
- **Pros:** Official NestJS package (`@nestjs/bullmq`), so DI, lifecycle, and graceful shutdown are handled by the framework rather than hand-rolled. Retry/backoff and the failed set map directly onto the `failed` terminal status Phase 03 needs. Redis adds one small, well-understood container. Job progress reporting is native, which Fase 04 can reuse for an upload/processing progress UI.
- **Cons:** Introduces Redis as new infrastructure (one more Compose service and one more production dependency). Redis persistence must be considered — an un-persisted Redis loses queued jobs on restart.

### Option B: PostgreSQL-backed queue (`pg-boss`)
- Uses the PostgreSQL instance already in the stack as the queue substrate (`SKIP LOCKED` polling). Also supports retries, backoff, and archived/failed job tables.
- **Pros:** No new infrastructure — reuses the database that already exists and is already backed up. Jobs are transactional with domain writes, so "create the video row and enqueue the job" can be one atomic unit.
- **Cons:** No first-party NestJS integration — module wiring, worker bootstrap and shutdown are hand-rolled. Puts polling load on the primary OLTP database, which also serves the read path for streaming metadata. Video processing is long-running (minutes for large files); long visibility timeouts on a Postgres-backed queue contend with connection-pool limits shared with the request path.
- **Note (dependency):** if chosen, TD-05's worker runtime must still open its own DataSource, so the "no new infrastructure" gain does not extend to the worker's process topology.

### Option C: RabbitMQ via `@nestjs/microservices`
- A dedicated AMQP broker with a NestJS transport adapter; the worker is a NestJS microservice consuming a queue.
- **Pros:** Purpose-built broker with mature routing, dead-letter exchanges and per-message acknowledgement. Native NestJS transport.
- **Cons:** Heaviest operational surface of the three (broker configuration, exchanges, bindings, vhosts) for a single job type. Retry/backoff is not built in — it requires dead-letter-exchange plumbing that BullMQ gives for free. Overkill for one producer, one consumer, one job name.

**Recommendation:** **Option A (BullMQ + Redis)** — it is the only option that gives first-party NestJS integration *and* built-in retry/backoff/failed-set semantics, which is exactly the surface TD-04's `failed` status needs. The cost is one Redis container, which is small next to the hand-rolled worker lifecycle that Option B requires and the broker topology Option C requires. Redis is configured with AOF persistence so a broker restart does not silently drop queued jobs.

**Decision:** _[pending]_

---

## TD-03: Large-File Upload Strategy (up to 10GB)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB body must never traverse the NestJS request pipeline — a single Node process buffering or even streaming 10GB blocks an event loop that also serves every other request, and a dropped connection restarts the whole transfer. The handshake between client and backend is a contract both sides implement, hence `Scope: Cross-layer` even though the frontend is out of scope this phase: the API contract defined here is what Fase 04/05 clients will consume.

**Options:**

### Option A: S3 multipart upload with presigned part URLs, orchestrated by the API
- Three API calls frame the transfer. `POST /videos` creates the draft row (TD-04) and calls `CreateMultipartUpload`, returning `videoId`, `uploadId`, `partSize` and a batch of presigned `UploadPart` URLs. The client `PUT`s each chunk **directly to storage**, collecting `ETag` per part. `POST /videos/:id/uploads/complete` sends the `{ partNumber, etag }` list, the API calls `CompleteMultipartUpload` and enqueues the processing job.
- **Pros:** Not a single video byte passes through the API — the requirement is satisfied structurally, not by tuning. Parts upload in parallel and a failed part is retried alone, so a dropped connection costs one part, not 10GB. S3's own 5GB single-`PUT` ceiling is bypassed (multipart tops out at 5TB), so 10GB is comfortably in range. Presigned URLs are short-lived and scoped to one key + one part number, so the client never holds storage credentials. Works identically against MinIO and S3.
- **Cons:** The most client work of the three options — the client must chunk the file, track part numbers and ETags, and drive three endpoints. The API must own orphan-upload cleanup (`AbortMultipartUpload`) for drafts that are never completed.

### Option B: Single presigned `PUT` (`PutObjectCommand`)
- One presigned URL; the client `PUT`s the whole file in one request.
- **Pros:** Simplest possible client and a single API call. Still keeps bytes out of the API.
- **Cons:** S3 caps a single `PUT` at 5GB, so 10GB is not expressible — the capability bullet cannot be met. No resume: a failure at 9GB restarts from zero. No parallelism, so throughput is bounded by one connection.

### Option C: `tus` resumable upload protocol via a tus server
- A dedicated resumable-upload protocol; the client speaks tus to a tus endpoint that persists chunks and finally moves the object into storage.
- **Pros:** Best-in-class resumability semantics, including resume across sessions and days. Protocol-level, client-library ecosystem exists.
- **Cons:** Adds a fourth new runtime component to a phase that already adds three (storage, broker, worker). Either the bytes traverse a tus handler inside the NestJS process — reintroducing exactly the problem being solved — or a separate tus service is deployed and the object still has to be relayed into S3 afterwards, doubling the write. The resume guarantee beyond what multipart already provides is not required by any Phase 03 bullet.

**Recommendation:** **Option A (S3 multipart with presigned part URLs)** — it is the only option that both keeps the payload out of the API and expresses a 10GB object, and it reuses the storage client TD-01 already introduces instead of adding a fourth service. The extra client complexity is the correct place to pay: the client is the only party that holds the file. Server-side declared size is validated against a 10GB ceiling at `POST /videos` so an oversized upload is rejected before a single part is presigned.

**Decision:** _[pending]_

---

## TD-04: Video Status Lifecycle and Processing-Failure Policy

**Scope:** Backend

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The phase requires a draft row to exist the moment an upload starts, and the plan brief states the cycle `rascunho → processando → pronto/erro`. The exact state set, the transitions, and what happens when FFmpeg fails are a cross-component contract: the API writes the initial state, the worker writes the terminal states, and Fase 04's management panel reads them. Deciding it once here prevents the API and the worker from disagreeing about what "processing" means.

**Options:**

### Option A: Four-state enum `draft → processing → ready | failed`, worker-owned terminal states, retry-then-fail
- `POST /videos` inserts the row as `draft`. `POST /videos/:id/uploads/complete` flips it to `processing` and enqueues the job in the same request. The worker writes `ready` (with duration, metadata and thumbnail key) or, after the queue's retry budget is exhausted, `failed` with a human-readable `processing_error`. `failed` is terminal for this phase.
- **Pros:** Exactly the four states the project brief names — no invented vocabulary. Every state is observable in one column, so the DB is the single source of truth (`Ciclo de status do vídeo refletido no banco`). Retry budget lives in the queue (TD-02), not in bespoke code. `processing_error` gives the owner an actionable reason instead of an opaque failure.
- **Cons:** Does not distinguish "draft created, bytes still uploading" from "draft created, upload abandoned" — an abandoned draft stays `draft` forever until a cleanup routine reaps it.

### Option B: Five states, adding an explicit `uploading` state
- `draft` on create, `uploading` while parts are being sent, then `processing`, `ready`, `failed`.
- **Pros:** Distinguishes an abandoned draft from one actively transferring; enables a more precise UI.
- **Cons:** The API cannot observe the upload — the parts go straight to storage (TD-03), so nothing server-side can move the row into or out of `uploading` truthfully. The state would be client-asserted, i.e. unverifiable. It also contradicts the brief's stated cycle, adding vocabulary the plan never asked for.

### Option C: Four states with automatic re-enqueue on failure (no terminal `failed`)
- On failure the job is re-enqueued indefinitely with growing backoff; the row oscillates between `processing` and `failed`.
- **Pros:** Transient infrastructure failures self-heal without intervention.
- **Cons:** A permanently undecodable file (corrupt container, unsupported codec) never settles, burning worker capacity forever and leaving the owner with a row that never reaches a final answer. Indefinite retry is the wrong default for a deterministic input.

**Recommendation:** **Option A** — the four states the brief names, terminal `failed` after a bounded retry budget (3 attempts, exponential backoff, supplied by TD-02), and a `processing_error` column carrying the reason. The abandoned-draft gap is accepted for this phase and handled by aborting the underlying multipart upload when a draft is deleted; a scheduled reaper is out of scope here (no capability bullet covers it) and is noted for a later phase.

**Decision:** _[pending]_

---

## TD-05: Video Worker Runtime and Deployment Topology

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** `docs/diagrams/software-arch.mermaid` draws the `Video Worker (FFmpeg)` as a container distinct from the API, reading and writing both storage and the database. What is open is how that container is realized: whether it is a separate process at all, how it is built, and how it reaches the database. FFmpeg transcoding saturates CPU; running it in the API process would starve request handling.

**Options:**

### Option A: Separate Compose service running a NestJS standalone application context, sharing the `src/` tree
- A second service (`video-worker`) built from its own Dockerfile (Node + `ffmpeg`), mounting the same source tree, booting `NestFactory.createApplicationContext(WorkerModule)` from a dedicated entrypoint (`src/worker/main.worker.ts`). `WorkerModule` imports the TypeORM connection, the storage module and the BullMQ queue registration, and hosts the `@Processor`.
- **Pros:** Honours the architecture diagram literally — a separate container with its own CPU budget, scalable independently of the API. Reuses entities, config namespaces and the storage adapter with zero duplication, so the worker and the API can never drift on the schema. A standalone context has no HTTP server, so the worker exposes no attack surface. `@nestjs/bullmq` registers the worker automatically on bootstrap and closes it on shutdown.
- **Cons:** A second image to build (the API image does not need FFmpeg, the worker does), and one more Compose service to keep healthy. The worker holds its own database connection pool.

### Option B: Same process as the API, `@Processor` registered inside `AppModule`
- The API process both serves HTTP and consumes jobs.
- **Pros:** No second image, no second service, no second connection pool — the simplest possible setup.
- **Cons:** FFmpeg's CPU load lands on the process serving requests; a single 10GB transcode degrades every endpoint. Cannot scale processing independently. Contradicts the architecture diagram, which the phase brief explicitly names as the target.

### Option C: Separate service that talks to the API over HTTP instead of to the database
- Worker consumes the job, processes, then calls an internal API endpoint to persist results.
- **Pros:** Single writer to the database; the worker needs no DB credentials.
- **Cons:** Requires an internal authenticated write endpoint that exists only to serve the worker — new surface, new auth story, new failure mode (worker finished but callback failed). The architecture diagram already shows `worker → db` as a direct relation. Adds latency and a second consistency boundary for no benefit at this scale.

**Recommendation:** **Option A** — a `video-worker` Compose service running a NestJS standalone application context off the shared source tree, built from a Dockerfile that installs `ffmpeg` (which brings `ffprobe`). It matches the target architecture, isolates CPU, and reuses the exact entity and config code the API uses, so schema drift between writer and reader is structurally impossible.

**Decision:** _[pending]_

---

## TD-06: Metadata Extraction and Thumbnail Generation Toolchain

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must read duration/width/height/codec/bitrate from the uploaded object and cut one frame into a thumbnail. Two sub-questions are coupled and decided together: which Node interface drives FFmpeg, and how the tool reaches a 10GB object that lives in storage rather than on the worker's disk.

**Options:**

### Option A: Direct `ffprobe`/`ffmpeg` invocation via `node:child_process`, reading a presigned GET URL over HTTP
- The worker signs a short-lived GET URL for the source object and passes it as the input to `ffprobe -print_format json -show_format -show_streams` and then to `ffmpeg -ss <t> -i <url> -frames:v 1 …`. No wrapper library; `execFile` with an argument array.
- **Pros:** No dependency at all — FFmpeg is already required in the worker image, and `execFile` with an array of arguments is shell-injection-proof by construction. `ffprobe` and a seeked single-frame grab only need the container header plus one keyframe region, which FFmpeg fetches with HTTP range requests, so a 10GB source costs a few MB of transfer and **zero** worker disk. JSON output from `ffprobe` is a stable, documented contract that is trivial to parse and to assert on in tests.
- **Cons:** The project owns the argument strings and the JSON parsing rather than a library's typed API. Requires the FFmpeg build in the image to include the HTTPS/HTTP protocol (standard in Debian's `ffmpeg` package).

### Option B: `fluent-ffmpeg` wrapper library
- A fluent JS API over the FFmpeg CLI, with helpers such as `.screenshots()` and `.ffprobe()`.
- **Pros:** Readable chained API; `screenshots()` encapsulates the thumbnail recipe.
- **Cons:** Adds a dependency whose maintenance cadence is slow, for a wrapper over two commands the project invokes exactly once each. It still shells out to the same binary, so it removes no risk — it only moves the argument strings behind an abstraction. Its callback-based API needs promisifying to fit the codebase's `async/await` convention.

### Option C: Direct invocation, but download the object to a temp file first
- Worker `GetObject`s the full source to local disk, runs FFmpeg against the file, then deletes it.
- **Pros:** Simplest failure semantics; no dependency on the FFmpeg build's HTTP protocol support.
- **Cons:** Requires up to 10GB of scratch disk per concurrent job, and pays a full 10GB read to extract a few kilobytes of metadata and one frame. Directly at odds with the phase's "sem impacto na performance" constraint.

**Recommendation:** **Option A** — `execFile`-based invocation of `ffprobe`/`ffmpeg` against a short-lived presigned GET URL. It adds no dependency, keeps 10GB off the worker's disk by relying on FFmpeg's HTTP range reads, and the `ffprobe` JSON contract is the most testable of the three. The thumbnail is captured at a seek point derived from the probed duration (10%, clamped to at least 1s) so that black lead-in frames are avoided, then uploaded to `thumbnails/{videoId}/thumbnail.jpg`.

**Decision:** _[pending]_

---

## TD-07: Unique Video URL Identifier Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a short, collision-free public identifier used in its URL, distinct from the internal UUID primary key. `docs/project-plan.md` § Pontos de Atenção states the requirement as "cada vídeo precisa de uma URL curta e única que nunca conflite com outro". This identifier is a permanent external contract — it appears in links users share, so it can never be reassigned.

**Options:**

### Option A: 11-character URL-safe slug from `node:crypto` random bytes, unique column, retry on collision
- `randomBytes(8).toString('base64url')` yields 11 URL-safe characters (~2^64 space). Stored in a `slug` column with a unique index; insert retries with a fresh slug on a unique-violation, mirroring the nickname-collision pattern already established in `ChannelsService`.
- **Pros:** Zero dependencies — `node:crypto` is standard library. Short and opaque, so it leaks neither creation order nor volume. The unique index makes "nunca conflite" a database guarantee rather than a probabilistic hope. The retry-on-unique-violation pattern already exists in the codebase (`channels/channels.service.ts`), so it is a convention reuse, not a new idea.
- **Cons:** The project owns 5 lines of generator code instead of importing them.

### Option B: `nanoid`
- The de-facto short-ID library, 21 characters by default, configurable alphabet and length.
- **Pros:** Widely used, well-audited generator; collision math published.
- **Cons:** Version 5 is ESM-only, which collides with this project's CommonJS + `ts-jest` setup and would force either a v3 pin (unmaintained branch) or transform configuration changes. That is a real, non-hypothetical cost for functionality `node:crypto` provides directly.

### Option C: Reuse the UUID primary key as the public identifier
- The URL carries the `id` column.
- **Pros:** Nothing to generate, nothing to index, no collision handling.
- **Cons:** 36 characters is not "curta"; the project plan calls for a short URL. It also exposes the internal primary key in every shared link, coupling the public contract to the storage key and removing the option to rotate one without the other.

**Recommendation:** **Option A** — an 11-character `base64url` slug from `node:crypto`, held in a unique-indexed `slug` column with retry-on-collision. It satisfies "curta e única" with a database-enforced guarantee, adds no dependency, sidesteps the `nanoid` ESM/CommonJS trap, and reuses the collision-retry convention the codebase already established for channel nicknames.

**Decision:** _[pending]_

---

## TD-08: Video Streaming Delivery Strategy

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** Playback must start without downloading the whole file, which in practice means honouring HTTP `Range` requests and answering `206 Partial Content`. The open question is who answers them: the API, or object storage directly via a redirect. The answer also decides where authorization for a video lives, which matters because Fase 04 introduces `unlisted` visibility.

**Options:**

### Option A: API proxies the byte range — `GET /videos/:slug/stream` returns `206` with a piped stream
- The controller parses the `Range` header, asks storage for that exact byte range (`GetObjectCommand` with `Range`), and pipes the returned stream to the response with `Content-Range`, `Accept-Ranges: bytes` and `Content-Length`. A request without `Range` gets `200` plus `Accept-Ranges: bytes`.
- **Pros:** Authorization stays on every single request, which is what `unlisted` and any future private video need — the check cannot be bypassed by resharing a URL. The response is a stable, versionable API contract rather than a redirect to a third-party host, so clients never see storage hostnames. It is exercisable end-to-end by the project's own supertest suite against real MinIO, satisfying "não mocke o que dá para testar de verdade". Only the requested range is fetched from storage, so the API never buffers the whole object.
- **Cons:** Video bytes traverse the API process, consuming its bandwidth — the operational cost this phase accepts on the *read* path (the write path, which carries the 10GB, is kept out of the API by TD-03). Requires care to stream rather than buffer.

### Option B: `302` redirect to a short-lived presigned GET URL
- The API validates access once, then redirects to a presigned storage URL; the player follows the redirect and storage serves `206` natively.
- **Pros:** Zero bytes through the API; storage handles ranges natively and scales independently. Matches the `frontend → storage: Streams` relation drawn in the architecture diagram.
- **Cons:** Authorization degrades to "valid for the URL's lifetime, for anyone holding it" — the link is bearer-grade and shareable, which weakens `unlisted` before Fase 04 even defines it. Presigned URLs must be signed with a host reachable by the *browser*, while the API and tests reach MinIO on the Compose network name; the two differ, so the phase would ship a delivery path its own test suite cannot exercise end-to-end.

### Option C: Public bucket with direct object URLs
- Objects are world-readable; the API returns a plain URL.
- **Pros:** Cheapest and simplest; storage does everything.
- **Cons:** No authorization at all, ever. Incompatible with `unlisted` visibility in Fase 04 and with any future private video. Rejected on those grounds.

**Recommendation:** **Option A** — the API answers `Range` with `206 Partial Content`, streaming only the requested window out of storage. Per-request authorization is the deciding factor: Fase 04 introduces `unlisted`, and a bearer-grade presigned link cannot express it. The bandwidth cost is bounded and acceptable at this stage, and the presigned-redirect path in Option B remains available later as a pure delivery optimization behind the same endpoint, without changing the API contract.

**Decision:** _[pending]_

---

## TD-09: Video Download Delivery

**Scope:** Backend

**Capability:** Download do vídeo pelo usuário

**Context:** Alongside streaming playback, the user must be able to download the file. The question is whether download is a distinct endpoint or a flag on the streaming endpoint, and how the browser is told to save rather than play.

**Options:**

### Option A: Dedicated `GET /videos/:slug/download` returning `200` with `Content-Disposition: attachment`
- A separate route streams the full object with `Content-Disposition: attachment; filename="<title>.<ext>"`, `Content-Type` from the stored MIME type, and `Content-Length`.
- **Pros:** Intent is explicit in the URL, so the two capabilities (`Reprodução via streaming` and `Download do vídeo pelo usuário`) map one-to-one onto two routes and two acceptance criteria. Separate routes can diverge later (different rate limits, download counters in a future phase) without a breaking change. The filename is server-controlled and derived from the video title, so the saved file is meaningful.
- **Cons:** One more route and one more OpenAPI block; some streaming code is shared with TD-08 and must be factored rather than duplicated.

### Option B: Same streaming endpoint with a `?download=true` query flag
- One route, a query parameter toggling the `Content-Disposition` header.
- **Pros:** One route, one implementation.
- **Cons:** Conflates two different behaviours behind a boolean, which REST conventions in `.claude/rules/nestjs-controllers.md` discourage; caching and future per-behaviour policies (rate limiting, counters) become awkward because both share a cache key and a route identity.

### Option C: Presigned GET URL with `response-content-disposition` returned as JSON
- The API returns a short-lived storage URL that forces the attachment header.
- **Pros:** No bytes through the API.
- **Cons:** Same bearer-grade authorization weakness as TD-08 Option B, and it would make download and streaming use two different security models within one phase. Inconsistent.

**Recommendation:** **Option A** — a dedicated `GET /videos/:slug/download` streaming the object with `Content-Disposition: attachment`, sharing the storage-read helper with the streaming route. It keeps the two capability bullets separately observable, keeps one authorization model across both delivery paths, and leaves room for download-specific policy later.

**Decision:** _[pending]_

---

## TD-10: Test Strategy for the New External Infrastructure

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Phase 03 adds three external systems the existing suite has never touched: object storage, a queue broker, and an FFmpeg toolchain. `CLAUDE.md` fixes the suffix contract (`*.spec.ts` / `*.integration-spec.ts` / `*.e2e-spec.ts`) but not which of the new systems are real in tests. This is a cross-component decision — it constrains the Compose file, the Jest configuration and every test file in the phase — and getting it wrong produces a suite that is green while the feature is broken.

**Options:**

### Option A: Real MinIO and real Redis from Compose in integration and E2E; real FFmpeg in the worker's integration tests using a tiny generated fixture
- Integration and E2E tests connect to the same `minio` and `redis` services the app uses, against dedicated test prefixes/queues. The worker's processing test runs actual `ffprobe`/`ffmpeg` against a small clip generated on the fly by FFmpeg's `testsrc` source. Unit tests keep mocking at module boundaries.
- **Pros:** The failure modes that actually break this feature — a wrong presigned signature, a malformed `Range` header, a missing bucket, an unparsable `ffprobe` payload — are only reachable against the real services; mocks reproduce the project's assumptions, not S3's behaviour. It matches the existing convention: the suite already talks to real PostgreSQL and real Mailpit rather than mocking them. A generated fixture keeps the repository free of binary blobs while still exercising the real decoder.
- **Cons:** Integration tests need the full Compose stack running, and the suite gets slower. Test isolation must be deliberate — unique keys per test and explicit cleanup.

### Option B: Mock the storage client and the queue; test only the project's own logic
- `@aws-sdk/client-s3` and `Queue` replaced by jest mocks everywhere.
- **Pros:** Fast, hermetic, no infrastructure needed to run tests.
- **Cons:** Proves only that the code calls the functions the code was written to call. A presigned URL that storage rejects, a `Content-Range` off by one byte, or a bucket that was never created all pass. The phase brief explicitly rejects this ("não mocke o que dá para testar de verdade com a infra do Compose").

### Option C: Testcontainers — spin up MinIO and Redis per test run
- Containers started programmatically by the test process.
- **Pros:** Full isolation per run; no dependency on a pre-started Compose stack.
- **Cons:** Introduces a dependency and a docker-in-docker requirement inside the already-containerized test runner, which the project's "everything runs inside the container" rule makes awkward. It duplicates infrastructure the Compose file already declares, and it diverges from how PostgreSQL and Mailpit are already handled in this repository.

**Recommendation:** **Option A** — real MinIO, real Redis and real FFmpeg from the Compose stack, mirroring how PostgreSQL and Mailpit are already used, with per-test key namespacing and explicit cleanup for isolation. The video fixture is generated at test time via FFmpeg's `testsrc`/`lavfi` inputs, so no binary artifact enters the repository and the decoder path is genuinely exercised.

**Decision:** _[pending]_

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Object Storage Client and Bucket/Key Organization | A (`@aws-sdk/client-s3` + presigner, single bucket with prefixes) | _[pending]_ |
| TD-02 | Backend | Background Job Queue Technology | A (BullMQ over Redis + `@nestjs/bullmq`) | _[pending]_ |
| TD-03 | Cross-layer | Large-File Upload Strategy (up to 10GB) | A (S3 multipart with presigned part URLs) | _[pending]_ |
| TD-04 | Backend | Video Status Lifecycle and Processing-Failure Policy | A (`draft → processing → ready \| failed`, terminal failure after retry budget) | _[pending]_ |
| TD-05 | Backend | Video Worker Runtime and Deployment Topology | A (separate Compose service, NestJS standalone context) | _[pending]_ |
| TD-06 | Backend | Metadata Extraction and Thumbnail Generation Toolchain | A (`execFile` ffprobe/ffmpeg over presigned GET URL) | _[pending]_ |
| TD-07 | Backend | Unique Video URL Identifier Strategy | A (11-char `base64url` slug from `node:crypto`, unique index + retry) | _[pending]_ |
| TD-08 | Backend | Video Streaming Delivery Strategy | A (API proxies Range, `206 Partial Content`) | _[pending]_ |
| TD-09 | Backend | Video Download Delivery | A (dedicated route with `Content-Disposition: attachment`) | _[pending]_ |
| TD-10 | Backend | Test Strategy for the New External Infrastructure | A (real MinIO/Redis/FFmpeg from Compose, generated fixture) | _[pending]_ |
