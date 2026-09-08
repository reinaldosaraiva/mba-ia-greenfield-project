---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 14
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-08T09:40:50-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-08T09:29:39-03:00"
issues:
  - id: IC-1
    status: open
    summary: "TD-08 keeps streaming behind the API while software-arch.mermaid draws frontend->storage"
  - id: AMB-1
    status: open
    summary: "Capabilities do not say who may stream/download a video in Phase 03"
  - id: AMB-2
    status: open
    summary: "'URL unica por video' does not say whether a metadata endpoint resolves it"
  - id: DG-1
    status: open
    summary: "No prior-phase way to resolve the authenticated user's channel"
  - id: OQ-1
    status: open
    summary: "TD-01 pending — object storage client and bucket/key organization"
  - id: OQ-2
    status: open
    summary: "TD-02 pending — background job queue technology"
  - id: OQ-3
    status: open
    summary: "TD-03 pending — large-file upload strategy"
  - id: OQ-4
    status: open
    summary: "TD-04 pending — video status lifecycle and failure policy"
  - id: OQ-5
    status: open
    summary: "TD-05 pending — video worker runtime and topology"
  - id: OQ-6
    status: open
    summary: "TD-06 pending — metadata extraction and thumbnail toolchain"
  - id: OQ-7
    status: open
    summary: "TD-07 pending — unique video URL identifier strategy"
  - id: OQ-8
    status: open
    summary: "TD-08 pending — video streaming delivery strategy"
  - id: OQ-9
    status: open
    summary: "TD-09 pending — video download delivery"
  - id: OQ-10
    status: open
    summary: "TD-10 pending — test strategy for the new external infrastructure"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

- **IC-1** — `phase-03-videos/TD-08` recommends that the API answer `Range` requests itself and stream bytes from storage, while the inherited architecture diagram `docs/diagrams/software-arch.mermaid` draws the relation `Rel(frontend, storage, "Streams", "HTTPS")`, i.e. the client reading from object storage directly. The two describe different delivery paths for the same capability. Explicit choice: (a) adopt TD-08 Option B (presigned redirect) so the code matches the diagram; (b) adopt TD-08 Option A and record, in the TD, that the diagram's relation is a later delivery optimization that does not change the API contract.

### Ambiguities

- **AMB-1** — The capability bullets `Reprodução via streaming (sem necessidade de download completo)` and `Download do vídeo pelo usuário` do not state who is allowed to stream or download in this phase. Visibility (`público` / `unlisted`) and the publication flow only arrive in Fase 04, and anonymous viewing is a Fase 05 bullet, so Phase 03 has no vocabulary to express "published". Without an explicit answer the Authorization Matrix cannot be written. Explicit choice: (a) both routes are owner-only in Phase 03 and open up in Fase 04 when visibility exists; (b) both routes are public for any `ready` video from day one.
- **AMB-2** — `URL única por vídeo, sem conflito com outros vídeos` fixes the identifier but not what the identifier resolves to. Nothing in the bullets says whether Phase 03 exposes a metadata endpoint keyed by that URL, yet the streaming and download routes need it to be addressable and a client needs some way to observe the `processing → ready` transition. Explicit choice: (a) Phase 03 exposes a read-only metadata endpoint keyed by the unique identifier, and the video-management surfaces stay with Fase 04; (b) no metadata endpoint in Phase 03 — status is unobservable over HTTP until Fase 04.

### Missing Decisions

_None._

### Dependency Gaps

- **DG-1** — A video belongs to a channel, and every request carries only the JWT payload `{ sub, email }` (`phase-02-auth/TD-02`). No prior phase delivered a way to resolve a user's channel: `ChannelsService` exposes only `createChannel`, and `UsersService.findByEmailWithChannel` keys on email rather than on the authenticated user id. Every write endpoint of this phase needs that lookup before it can attach a video to its owner. Explicit choice: (a) extend `ChannelsService` with a lookup by `user_id`, keeping channel ownership inside `ChannelsModule`; (b) let the videos module query the `channels` table directly.

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

- **OQ-1** — TD-01 pending — object storage client and bucket/key organization. Resolution: fill the **Decision:** field of TD-01 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-2** — TD-02 pending — background job queue technology. Resolution: fill the **Decision:** field of TD-02, then re-run `/plan-validate phase-03-videos`.
- **OQ-3** — TD-03 pending — large-file upload strategy. Resolution: fill the **Decision:** field of TD-03, then re-run `/plan-validate phase-03-videos`.
- **OQ-4** — TD-04 pending — video status lifecycle and processing-failure policy. Resolution: fill the **Decision:** field of TD-04, then re-run `/plan-validate phase-03-videos`.
- **OQ-5** — TD-05 pending — video worker runtime and deployment topology. Resolution: fill the **Decision:** field of TD-05, then re-run `/plan-validate phase-03-videos`.
- **OQ-6** — TD-06 pending — metadata extraction and thumbnail generation toolchain. Resolution: fill the **Decision:** field of TD-06, then re-run `/plan-validate phase-03-videos`.
- **OQ-7** — TD-07 pending — unique video URL identifier strategy. Resolution: fill the **Decision:** field of TD-07, then re-run `/plan-validate phase-03-videos`.
- **OQ-8** — TD-08 pending — video streaming delivery strategy. Resolution: fill the **Decision:** field of TD-08, then re-run `/plan-validate phase-03-videos`.
- **OQ-9** — TD-09 pending — video download delivery. Resolution: fill the **Decision:** field of TD-09, then re-run `/plan-validate phase-03-videos`.
- **OQ-10** — TD-10 pending — test strategy for the new external infrastructure. Resolution: fill the **Decision:** field of TD-10, then re-run `/plan-validate phase-03-videos`.

### UI Coverage Gaps

_None._ — no UI scope in this phase.

## Resolved Issues

_No issues resolved yet._
