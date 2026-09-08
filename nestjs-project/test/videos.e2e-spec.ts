import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { VideoProcessingModule } from '../src/videos/processing/video-processing.module';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { generateVideoClip, GeneratedClip } from '../src/test/video-fixture';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';

const MIN_PART_SIZE = 5 * 1024 * 1024;

const VALID_BODY = {
  title: 'My holiday clip',
  filename: 'holiday.mp4',
  size_bytes: 20 * 1024 * 1024,
  mime_type: 'video/mp4',
};

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let processingQueue: Queue;
  let clip: GeneratedClip;
  const touchedPrefixes: string[] = [];

  beforeAll(async () => {
    // VideoProcessingModule runs the real BullMQ worker in-process, so the
    // create -> upload -> complete -> ready path is exercised end to end against
    // the same Redis, MinIO and FFmpeg the worker container uses.
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule, VideoProcessingModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    storage = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    processingQueue = moduleFixture.get<Queue>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
    clip = await generateVideoClip(3, 320, 240);
  }, 120000);

  afterAll(async () => {
    for (const prefix of touchedPrefixes) {
      await storage.deletePrefix(prefix);
    }
    await clip.cleanup();
    await app.close();
  }, 60000);

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    await processingQueue.drain();
  });

  let userCounter = 0;
  async function signIn(): Promise<string> {
    const email = `videos_e2e_${++userCounter}_${Date.now()}@example.com`;
    const password = 'password123';

    const authService = app.get(AuthService);
    const mailService = (authService as any).mailService;
    let confirmationToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, token: string) => {
        confirmationToken = token;
        return Promise.resolve();
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken })
      .expect(204);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    return login.body.access_token as string;
  }

  async function createDraft(token: string, overrides = {}) {
    const response = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...VALID_BODY, ...overrides })
      .expect(201);
    touchedPrefixes.push(`videos/${response.body.id}/`);
    return response.body;
  }

  function readVideo(token: string, slug: string) {
    return request(app.getHttpServer())
      .get(`/videos/${slug}`)
      .set('Authorization', `Bearer ${token}`);
  }

  async function waitForStatus(
    token: string,
    slug: string,
    expected: string,
    timeoutMs = 60000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    let last: Record<string, unknown> = {};

    while (Date.now() < deadline) {
      const response = await readVideo(token, slug);
      last = response.body as Record<string, unknown>;
      if (last.status === expected) {
        return last;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(
      `Video ${slug} never reached "${expected}" (last status: ${String(last.status)})`,
    );
  }

  describe('POST /videos', () => {
    it('pre-registers the video as a draft and returns the upload envelope', async () => {
      const token = await signIn();

      const response = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send(VALID_BODY)
        .expect(201);

      touchedPrefixes.push(`videos/${response.body.id}/`);
      expect(response.body.status).toBe('draft');
      expect(response.body.slug).toHaveLength(11);
      expect(response.body.upload).toEqual({
        upload_id: expect.any(String),
        part_size: 10485760,
        part_count: 2,
      });
    }, 60000);

    it('rejects a file larger than the configured maximum', async () => {
      const token = await signIn();

      const response = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...VALID_BODY, size_bytes: 10 * 1024 * 1024 * 1024 + 1 })
        .expect(400);

      expect(response.body.error).toBe('VIDEO_TOO_LARGE');
    }, 60000);

    it('rejects a content type that is not a supported video type', async () => {
      const token = await signIn();

      const response = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...VALID_BODY, mime_type: 'application/pdf' })
        .expect(415);

      expect(response.body.error).toBe('UNSUPPORTED_VIDEO_TYPE');
    }, 60000);

    it('rejects a body that fails schema validation', async () => {
      const token = await signIn();

      const response = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: '', filename: '', size_bytes: 0, mime_type: '' })
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
    }, 60000);

    it('rejects an unauthenticated request', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send(VALID_BODY)
        .expect(401);
    }, 60000);
  });

  describe('POST /videos/:id/uploads/parts', () => {
    it('returns presigned URLs that accept a part upload without credentials', async () => {
      const token = await signIn();
      const draft = await createDraft(token);

      const response = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/uploads/parts`)
        .set('Authorization', `Bearer ${token}`)
        .send({ part_numbers: [1] })
        .expect(200);

      expect(response.body.parts).toHaveLength(1);
      const upload = await fetch(response.body.parts[0].url, {
        method: 'PUT',
        body: Buffer.alloc(MIN_PART_SIZE, 'a'),
      });
      expect(upload.status).toBe(200);
    }, 60000);

    it('answers a video owned by another user as not found', async () => {
      const owner = await signIn();
      const draft = await createDraft(owner);
      const stranger = await signIn();

      const response = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/uploads/parts`)
        .set('Authorization', `Bearer ${stranger}`)
        .send({ part_numbers: [1] })
        .expect(404);

      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    }, 60000);

    it('keys the throttle by user so one uploader cannot exhaust another', async () => {
      const first = await signIn();
      const firstDraft = await createDraft(first);
      const second = await signIn();
      const secondDraft = await createDraft(second);

      for (let i = 0; i < 60; i++) {
        await request(app.getHttpServer())
          .post(`/videos/${firstDraft.id}/uploads/parts`)
          .set('Authorization', `Bearer ${first}`)
          .send({ part_numbers: [1] })
          .expect(200);
      }

      await request(app.getHttpServer())
        .post(`/videos/${firstDraft.id}/uploads/parts`)
        .set('Authorization', `Bearer ${first}`)
        .send({ part_numbers: [1] })
        .expect(429);

      await request(app.getHttpServer())
        .post(`/videos/${secondDraft.id}/uploads/parts`)
        .set('Authorization', `Bearer ${second}`)
        .send({ part_numbers: [1] })
        .expect(200);
    }, 120000);

    it('refuses part numbers beyond what the declared size allows', async () => {
      const token = await signIn();
      // 20MiB with the default 10MiB part size is exactly two parts.
      const draft = await createDraft(token);

      const response = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/uploads/parts`)
        .set('Authorization', `Bearer ${token}`)
        .send({ part_numbers: [1, 2, 3] })
        .expect(400);

      expect(response.body.error).toBe('INVALID_UPLOAD_PART');
    }, 120000);

    it('rejects a malformed video id', async () => {
      const token = await signIn();

      await request(app.getHttpServer())
        .post('/videos/not-a-uuid/uploads/parts')
        .set('Authorization', `Bearer ${token}`)
        .send({ part_numbers: [1] })
        .expect(400);
    }, 60000);
  });

  async function uploadEveryPart(
    token: string,
    videoId: string,
  ): Promise<{ part_number: number; etag: string }[]> {
    const presigned = await request(app.getHttpServer())
      .post(`/videos/${videoId}/uploads/parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: [1, 2] })
      .expect(200);

    const chunks = [Buffer.alloc(MIN_PART_SIZE, 'a'), Buffer.from('tail')];
    return Promise.all(
      (presigned.body.parts as { part_number: number; url: string }[]).map(
        async (part, index) => {
          const response = await fetch(part.url, {
            method: 'PUT',
            body: chunks[index],
          });
          expect(response.status).toBe(200);
          return {
            part_number: part.part_number,
            etag: response.headers.get('etag') as string,
          };
        },
      ),
    );
  }

  // A single-part upload: the real clip is far below the 5MiB multipart floor,
  // which S3 only enforces on parts that are not the last one.
  async function uploadWholeClip(
    token: string,
    videoId: string,
  ): Promise<void> {
    const presigned = await request(app.getHttpServer())
      .post(`/videos/${videoId}/uploads/parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: [1] })
      .expect(200);

    const upload = await fetch(presigned.body.parts[0].url as string, {
      method: 'PUT',
      // `Buffer<ArrayBufferLike>` is not assignable to fetch's BodyInit union;
      // a plain Uint8Array view is.
      body: new Uint8Array(clip.buffer),
    });
    expect(upload.status).toBe(200);

    await request(app.getHttpServer())
      .post(`/videos/${videoId}/uploads/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        parts: [{ part_number: 1, etag: upload.headers.get('etag') as string }],
      })
      .expect(202);
  }

  describe('POST /videos/:id/uploads/complete', () => {
    it('closes the handshake and moves the video to processing', async () => {
      const token = await signIn();
      const draft = await createDraft(token);
      const parts = await uploadEveryPart(token, draft.id);

      const response = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/uploads/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(202);

      expect(response.body).toEqual({
        id: draft.id,
        slug: draft.slug,
        status: 'processing',
      });
    }, 120000);

    it('rejects a second completion of the same upload', async () => {
      const token = await signIn();
      const draft = await createDraft(token);
      const parts = await uploadEveryPart(token, draft.id);

      await request(app.getHttpServer())
        .post(`/videos/${draft.id}/uploads/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(202);

      const response = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/uploads/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(409);

      expect(response.body.error).toBe('VIDEO_UPLOAD_NOT_PENDING');
    }, 120000);

    it('answers a video owned by another user as not found', async () => {
      const owner = await signIn();
      const draft = await createDraft(owner);
      const parts = await uploadEveryPart(owner, draft.id);
      const stranger = await signIn();

      const response = await request(app.getHttpServer())
        .post(`/videos/${draft.id}/uploads/complete`)
        .set('Authorization', `Bearer ${stranger}`)
        .send({ parts })
        .expect(404);

      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    }, 120000);
  });

  describe('GET /videos/:slug', () => {
    it('resolves the unique identifier to the video metadata', async () => {
      const token = await signIn();
      const draft = await createDraft(token);

      const response = await readVideo(token, draft.slug).expect(200);

      expect(response.body).toMatchObject({
        id: draft.id,
        slug: draft.slug,
        title: VALID_BODY.title,
        status: 'draft',
        mime_type: VALID_BODY.mime_type,
        original_filename: VALID_BODY.filename,
        duration_seconds: null,
        metadata: null,
        processing_error: null,
      });
    }, 120000);

    it('answers an unknown slug as not found', async () => {
      const token = await signIn();

      const response = await readVideo(token, 'doesnotexis').expect(404);

      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    }, 120000);

    it('answers a video owned by another user exactly like an unknown one', async () => {
      const owner = await signIn();
      const draft = await createDraft(owner);
      const stranger = await signIn();

      const response = await readVideo(stranger, draft.slug).expect(404);

      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    }, 120000);

    it('rejects an unauthenticated request', async () => {
      const token = await signIn();
      const draft = await createDraft(token);

      await request(app.getHttpServer())
        .get(`/videos/${draft.slug}`)
        .expect(401);
    }, 120000);
  });

  describe('GET /videos/:slug/thumbnail', () => {
    it('returns the generated JPEG once processing completes', async () => {
      const token = await signIn();
      const draft = await createDraft(token, {
        size_bytes: clip.buffer.length,
      });
      await uploadWholeClip(token, draft.id);

      const ready = await waitForStatus(token, draft.slug, 'ready');
      expect(ready.duration_seconds).toBe(clip.durationSeconds);

      const response = await request(app.getHttpServer())
        .get(`/videos/${draft.slug}/thumbnail`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.headers['content-type']).toContain('image/jpeg');
      expect(response.body.subarray(0, 3)).toEqual(
        Buffer.from([0xff, 0xd8, 0xff]),
      );
    }, 180000);

    it('answers 404 while the video is still processing', async () => {
      const token = await signIn();
      const draft = await createDraft(token);

      const response = await request(app.getHttpServer())
        .get(`/videos/${draft.slug}/thumbnail`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);

      expect(response.body.error).toBe('THUMBNAIL_NOT_AVAILABLE');
    }, 120000);
  });

  describe('GET /videos/:slug/stream', () => {
    async function readyVideo(): Promise<{ token: string; slug: string }> {
      const token = await signIn();
      const draft = await createDraft(token, {
        size_bytes: clip.buffer.length,
      });
      await uploadWholeClip(token, draft.id);
      await waitForStatus(token, draft.slug, 'ready');
      return { token, slug: draft.slug };
    }

    it('answers a Range request with 206 and exactly the requested window', async () => {
      const { token, slug } = await readyVideo();

      const response = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .set('Authorization', `Bearer ${token}`)
        .set('Range', 'bytes=0-99')
        .expect(206);

      expect(response.headers['content-range']).toBe(
        `bytes 0-99/${clip.buffer.length}`,
      );
      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(response.headers['content-length']).toBe('100');
      expect(response.body).toHaveLength(100);
      expect(response.body).toEqual(clip.buffer.subarray(0, 100));
    }, 180000);

    it('serves the whole object when no Range header is sent', async () => {
      const { token, slug } = await readyVideo();

      const response = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(response.headers['content-length']).toBe(
        String(clip.buffer.length),
      );
    }, 180000);

    it('rejects a range beyond the object with 416 and the total size', async () => {
      const { token, slug } = await readyVideo();

      const response = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .set('Authorization', `Bearer ${token}`)
        .set('Range', `bytes=${clip.buffer.length + 10}-`)
        .expect(416);

      expect(response.headers['content-range']).toBe(
        `bytes */${clip.buffer.length}`,
      );
      expect(response.body.error).toBe('INVALID_RANGE');
    }, 180000);

    it('refuses to stream a video that is not ready', async () => {
      const token = await signIn();
      const draft = await createDraft(token);

      const response = await request(app.getHttpServer())
        .get(`/videos/${draft.slug}/stream`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);

      expect(response.body.error).toBe('VIDEO_NOT_READY');
    }, 120000);

    it('rejects an unauthenticated request', async () => {
      const { slug } = await readyVideo();

      await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .expect(401);
    }, 180000);

    it('answers a video owned by another user as not found', async () => {
      const { slug } = await readyVideo();
      const stranger = await signIn();

      const response = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .set('Authorization', `Bearer ${stranger}`)
        .expect(404);

      expect(response.body.error).toBe('VIDEO_NOT_FOUND');
    }, 180000);
  });

  describe('GET /videos/:slug/download', () => {
    it('returns the whole file as an attachment', async () => {
      const token = await signIn();
      const draft = await createDraft(token, {
        size_bytes: clip.buffer.length,
      });
      await uploadWholeClip(token, draft.id);
      await waitForStatus(token, draft.slug, 'ready');

      const response = await request(app.getHttpServer())
        .get(`/videos/${draft.slug}/download`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="${VALID_BODY.title}.mp4"; ` +
          `filename*=UTF-8''${encodeURIComponent(`${VALID_BODY.title}.mp4`)}`,
      );
      expect(response.headers['content-length']).toBe(
        String(clip.buffer.length),
      );
      expect(response.body).toEqual(clip.buffer);
    }, 180000);

    it('refuses to serve a video that is not ready', async () => {
      const token = await signIn();
      const draft = await createDraft(token);

      const response = await request(app.getHttpServer())
        .get(`/videos/${draft.slug}/download`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);

      expect(response.body.error).toBe('VIDEO_NOT_READY');
    }, 120000);
  });

  describe('DELETE /videos/:id/uploads', () => {
    it('aborts the upload and discards the draft', async () => {
      const token = await signIn();
      const draft = await createDraft(token);

      await request(app.getHttpServer())
        .delete(`/videos/${draft.id}/uploads`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      await request(app.getHttpServer())
        .post(`/videos/${draft.id}/uploads/parts`)
        .set('Authorization', `Bearer ${token}`)
        .send({ part_numbers: [1] })
        .expect(404);
    }, 60000);
  });
});
