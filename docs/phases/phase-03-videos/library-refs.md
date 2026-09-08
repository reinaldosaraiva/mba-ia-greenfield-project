---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1127.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-08T09:42:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1127.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-08T09:42:00-03:00"
  bullmq:
    version: "^6.3.4"
    context7_id: "/websites/bullmq_io"
    fetched_at: "2026-09-08T09:42:00-03:00"
  "@nestjs/bullmq":
    version: "^12.0.0"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-09-08T09:42:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-08T09:42:36-03:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries this phase pins, pulled via Context7. Re-fetch when the underlying TD changes.

Version compatibility confirmed against the registry from inside the container: `@nestjs/bullmq@12.0.0` declares `peerDependencies` `@nestjs/core: ^10 || ^11 || ^12` and `bullmq: ^3 || ^4 || ^5 || ^6`, so it pairs with the installed NestJS 11 and with `bullmq@6.3.4`.

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3` (Context7). Maps to `phase-03-videos/TD-01` (client + key layout), `TD-03` (multipart upload), `TD-08`/`TD-09` (range reads).

### Client construction against MinIO

MinIO speaks the S3 API but serves buckets on the path (`http://minio:9000/streamtube/key`) rather than as a subdomain, so `forcePathStyle` is mandatory. `region` is required by the signer even though MinIO ignores it.

```typescript
import { S3Client } from '@aws-sdk/client-s3';

const client = new S3Client({
  region: storage.region,
  endpoint: storage.endpoint, // http://minio:9000 — Compose service name, never localhost
  forcePathStyle: true,
  credentials: {
    accessKeyId: storage.accessKeyId,
    secretAccessKey: storage.secretAccessKey,
  },
});
```

### Bucket bootstrap

`HeadBucketCommand` throws when the bucket is absent; `CreateBucketCommand` is then idempotent enough for a startup hook.

```typescript
import { CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';

try {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
} catch {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
}
```

### Multipart upload lifecycle

```typescript
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';

// 1. open
const { UploadId } = await client.send(
  new CreateMultipartUploadCommand({ Bucket, Key, ContentType }),
);

// 2. one command per part — presigned, executed by the client (see presigner below)
const partCommand = new UploadPartCommand({
  Bucket,
  Key,
  UploadId,
  PartNumber, // 1-based, max 10000
});

// 3. close — Parts must be sorted ascending by PartNumber
await client.send(
  new CompleteMultipartUploadCommand({
    Bucket,
    Key,
    UploadId,
    MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"abc"' }] },
  }),
);

// 4. cleanup on abandon
await client.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
```

Constraints that shape the API contract: every part except the last must be at least 5 MiB; at most 10 000 parts; a part may be at most 5 GiB. With a 10 MiB part size, 10 GB needs ~1 024 parts — comfortably inside the limit.

### Ranged reads for streaming

`GetObjectCommand` accepts an HTTP `Range` value and the response carries `ContentLength`, `ContentRange` and a `Body` that is a Node `Readable` on the Node runtime, so it can be piped straight to the HTTP response.

```typescript
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

const head = await client.send(new HeadObjectCommand({ Bucket, Key }));
const total = head.ContentLength ?? 0;

const res = await client.send(
  new GetObjectCommand({ Bucket, Key, Range: `bytes=${start}-${end}` }),
);
(res.Body as Readable).pipe(response);
```

`Body` is typed as a union (`Readable | ReadableStream | Blob`); on Node it is always `Readable`. Cast at the boundary rather than widening the caller's types.

### Uploading a derived object (thumbnail)

```typescript
import { PutObjectCommand } from '@aws-sdk/client-s3';

await client.send(
  new PutObjectCommand({ Bucket, Key, Body: buffer, ContentType: 'image/jpeg' }),
);
```

## @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` (Context7). Maps to `phase-03-videos/TD-03` (part URLs) and `TD-06` (worker input URL).

`getSignedUrl(client, command, { expiresIn })` turns any S3 command into a URL the holder can execute without credentials. `expiresIn` is in seconds and defaults to 900.

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3';

// upload: one URL per part, PUT by the client with the raw chunk as the body
const partUrl = await getSignedUrl(
  client,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 3600 },
);

// worker input: short-lived read URL handed to ffprobe/ffmpeg
const sourceUrl = await getSignedUrl(
  client,
  new GetObjectCommand({ Bucket, Key }),
  { expiresIn: 900 },
);
```

Notes that matter here:

- Do **not** set `ContentType` on `UploadPartCommand` — S3 signs it into the URL and the client would have to reproduce the header byte-for-byte. The content type belongs on `CreateMultipartUploadCommand`.
- Headers that must travel with the request can be forced into the signature with `signableHeaders` / `unhoistableHeaders`. The part upload needs neither.
- The signed host is whatever `endpoint` the client was built with. Inside Compose that is the service name, which is what the worker and the test suite resolve.

## bullmq

**Source:** `/websites/bullmq_io` (Context7). Maps to `phase-03-videos/TD-02` (queue) and `TD-04` (failure policy).

### Retry budget and backoff

Retry semantics are per-job options, so the producer decides the budget:

```typescript
await queue.add(
  'process-video',
  { videoId },
  {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: true,
  },
);
```

A job that throws is retried while `attempts` remain; when the budget is exhausted it lands in the failed set. That is the boundary at which `TD-04` writes the terminal `failed` status.

### Skipping the retry budget

`UnrecoverableError` moves the job to the failed set immediately, bypassing remaining attempts — the right signal for a deterministic input failure such as a file FFmpeg cannot decode.

```typescript
import { UnrecoverableError } from 'bullmq';

throw new UnrecoverableError('ffprobe could not read the container');
```

### Job identity

`jobId` in the job options deduplicates: adding twice with the same id is a no-op while the first job is still active. Using the video id keeps a repeated `complete` call from enqueuing the same work twice.

## @nestjs/bullmq

**Source:** `/nestjs/bull` (Context7). Maps to `phase-03-videos/TD-02` and `TD-05` (worker runtime).

### Root registration (async, typed config)

```typescript
import { BullModule } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';

BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port },
  }),
});
```

`connection` is an ioredis connection option object; the host is the Compose service name.

### Producer side

`BullModule.registerQueue({ name })` in the module that publishes, then inject with `@InjectQueue(name)`:

```typescript
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

constructor(@InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue) {}
```

### Consumer side

A processor is a class decorated with `@Processor(queueName)` that extends `WorkerHost` and implements `process(job)`. The package discovers it at bootstrap and creates the underlying BullMQ `Worker`, closing it on shutdown.

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    // ...
  }
}
```

The worker options (concurrency, lock duration) are the decorator's second argument. Because the processor is registered by NestJS at bootstrap, hosting it in a standalone application context (`NestFactory.createApplicationContext`) is enough to run a worker with no HTTP server — which is exactly the topology `TD-05` chose.
