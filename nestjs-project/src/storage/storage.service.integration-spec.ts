import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MIN_PART_SIZE = 5 * 1024 * 1024;

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

describe('StorageService (integration)', () => {
  let service: StorageService;
  const createdPrefixes: string[] = [];

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    service = module.get(StorageService);
    await service.ensureBucket();
  }, 30000);

  afterAll(async () => {
    for (const prefix of createdPrefixes) {
      await service.deletePrefix(prefix);
    }
  }, 30000);

  function scopedKey(name: string): string {
    const prefix = `it-storage/${randomUUID()}/`;
    createdPrefixes.push(prefix);
    return `${prefix}${name}`;
  }

  it('creates the bucket on first use and stays idempotent', async () => {
    await expect(service.ensureBucket()).resolves.toBeUndefined();
    await expect(service.ensureBucket()).resolves.toBeUndefined();
  });

  it('completes a two-part multipart upload into a byte-identical object', async () => {
    const key = scopedKey('source.mp4');
    const first = Buffer.alloc(MIN_PART_SIZE, 'a');
    const second = Buffer.from('tail-bytes');

    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const parts = await Promise.all(
      [first, second].map(async (chunk, index) => {
        const url = await service.presignUploadPart(
          key,
          uploadId,
          index + 1,
          600,
        );
        const response = await fetch(url, { method: 'PUT', body: chunk });
        expect(response.status).toBe(200);
        return {
          partNumber: index + 1,
          etag: response.headers.get('etag') as string,
        };
      }),
    );

    await service.completeMultipartUpload(key, uploadId, parts);

    const head = await service.headObject(key);
    expect(head.contentLength).toBe(first.length + second.length);

    const stored = await service.getObjectRange(key);
    expect(await collect(stored.body)).toEqual(Buffer.concat([first, second]));
  }, 60000);

  it('leaves no object behind when a multipart upload is aborted', async () => {
    const key = scopedKey('aborted.mp4');

    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const url = await service.presignUploadPart(key, uploadId, 1, 600);
    await fetch(url, { method: 'PUT', body: Buffer.alloc(MIN_PART_SIZE, 'b') });

    await service.abortMultipartUpload(key, uploadId);

    await expect(service.objectExists(key)).resolves.toBe(false);
  }, 60000);

  it('returns exactly the requested byte window and the full object length', async () => {
    const key = scopedKey('ranged.bin');
    const payload = Buffer.from('0123456789abcdef');
    await service.putObject(key, payload, 'application/octet-stream');

    const head = await service.headObject(key);
    const window = await service.getObjectRange(key, { start: 5, end: 9 });

    expect(head.contentLength).toBe(payload.length);
    expect(window.contentLength).toBe(5);
    expect(await collect(window.body)).toEqual(Buffer.from('56789'));
  }, 30000);

  it('serves an object through a presigned GET URL without credentials', async () => {
    const key = scopedKey('presigned.txt');
    await service.putObject(key, Buffer.from('hello'), 'text/plain');

    const url = await service.presignGetObject(key, 600);
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello');
  }, 30000);

  it('reports a missing object as absent instead of throwing', async () => {
    await expect(service.objectExists(scopedKey('nope.mp4'))).resolves.toBe(
      false,
    );
  }, 30000);

  it('deletes every object under a prefix', async () => {
    const prefix = `it-storage/${randomUUID()}/`;
    await service.putObject(`${prefix}a.txt`, Buffer.from('a'), 'text/plain');
    await service.putObject(`${prefix}b.txt`, Buffer.from('b'), 'text/plain');

    await service.deletePrefix(prefix);

    await expect(service.objectExists(`${prefix}a.txt`)).resolves.toBe(false);
    await expect(service.objectExists(`${prefix}b.txt`)).resolves.toBe(false);
  }, 30000);
});
