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
import { cleanAllTables } from '../src/test/create-test-data-source';
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
  const touchedPrefixes: string[] = [];

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
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
  }, 60000);

  afterAll(async () => {
    for (const prefix of touchedPrefixes) {
      await storage.deletePrefix(prefix);
    }
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
