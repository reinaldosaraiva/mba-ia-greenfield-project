# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with two main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express). Contains modules for users, channels, videos, comments, etc.
- `docs/` — Project documentation, architecture diagrams, and planning.
- `next-frontend/` (Next.js) — frontend application (Fases 01-02 delivered; video screens start in Fase 05)

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST, streams from Object Storage
- **API** (Nest.js) → business rules, auth, reads/writes DB, uploads to storage, publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → consumes jobs from queue, processes videos, updates DB and storage
- **Database** (PostgreSQL) → users, channels, videos, comments, likes
- **Object Storage** (MinIO locally, S3-compatible in production) → video source files and thumbnails
- **Message Queue** (Redis + BullMQ) → video processing job queue
- **Email Service** (SMTP) → account confirmation and password recovery

## Videos

The videos module (`nestjs-project/src/videos/`) owns video ingestion, processing and delivery. Technical decisions are in `docs/decisions/technical-decisions-phase-03-videos.md`; the executable plan is `docs/phases/phase-03-videos/phase-03-videos.md`.

### Upload handshake (files up to 10GB)

The video bytes never traverse the API process. The client drives a three-call handshake and `PUT`s each chunk straight to object storage with a presigned URL:

1. `POST /videos` — validates the declared file, resolves the caller's channel, allocates the unique slug, opens an S3 multipart upload and persists the video as `draft`. Returns `upload_id`, `part_size` and `part_count`.
2. `POST /videos/:id/uploads/parts` — returns one presigned `UploadPart` URL per requested part number, in batches of up to 100.
3. `POST /videos/:id/uploads/complete` — closes the multipart upload with the reported parts, records the size storage actually stored, moves the video to `processing` and publishes the processing job.

`DELETE /videos/:id/uploads` aborts an abandoned upload and discards the draft.

### Status lifecycle

`draft → processing → ready | failed`. The API writes `draft` and `processing`; the worker writes `ready` or, once the retry budget is exhausted, `failed` with a readable `processing_error`. `failed` is terminal.

### Delivery

Every video route is owner-only — the global JWT guard authenticates and the service authorizes against the caller's channel. A video owned by someone else answers `404`, identical to an unknown one.

- `GET /videos/:slug` — metadata and current status, keyed by the unique public identifier.
- `GET /videos/:slug/thumbnail` — the JPEG the worker extracted.
- `GET /videos/:slug/stream` — honours HTTP `Range`, answering `206 Partial Content` so playback starts without downloading the whole file.
- `GET /videos/:slug/download` — the whole file as an attachment.

Visibility (`público` / `unlisted`) and anonymous viewing arrive in Fases 04 and 05; until then no video route is public.

### Worker

`video-worker` is a separate Compose service running a NestJS standalone application context (`src/worker/main.worker.ts`) with no HTTP surface. It consumes the `video-processing` BullMQ queue, reads the source through a short-lived presigned URL so FFmpeg fetches only the bytes it needs over HTTP range requests, extracts duration and metadata with `ffprobe`, cuts a thumbnail with `ffmpeg`, and updates the database and storage.

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.