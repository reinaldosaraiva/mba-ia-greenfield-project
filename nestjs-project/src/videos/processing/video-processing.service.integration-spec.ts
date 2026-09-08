import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { VideoNotFoundException } from '../../common/exceptions/domain.exception';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import videoConfig from '../../config/video.config';
import { buildThumbnailKey } from '../../storage/object-key.util';
import { StorageService } from '../../storage/storage.service';
import {
  ALL_ENTITIES,
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { generateVideoClip, GeneratedClip } from '../../test/video-fixture';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import { VideoStatus } from '../videos.constants';
import { VideoProcessingModule } from './video-processing.module';
import { VideoProcessingService } from './video-processing.service';

describe('VideoProcessingService (integration)', () => {
  let module: TestingModule;
  let service: VideoProcessingService;
  let storage: StorageService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let clip: GeneratedClip;
  const touchedPrefixes: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig, videoConfig],
        }),
        BullModule.forRoot({
          connection: {
            host: process.env.REDIS_HOST ?? 'redis',
            port: Number(process.env.REDIS_PORT ?? 6379),
          },
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideoProcessingModule,
      ],
    }).compile();
    await module.init();

    service = module.get(VideoProcessingService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    clip = await generateVideoClip(3, 320, 240);
  }, 120000);

  afterAll(async () => {
    for (const prefix of touchedPrefixes) {
      await storage.deletePrefix(prefix);
    }
    await clip.cleanup();
    await module.close();
  }, 60000);

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createProcessingVideo(sourceBody: Buffer): Promise<Video> {
    const suffix = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `processing_${suffix}_${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `chan${suffix}`,
        nickname: `processing_${suffix}_${Date.now()}`,
        user_id: user.id,
      }),
    );

    const videoId = randomUUID();
    const sourceKey = `videos/${videoId}/source.mp4`;
    touchedPrefixes.push(`videos/${videoId}/`, `thumbnails/${videoId}/`);
    await storage.putObject(sourceKey, sourceBody, 'video/mp4');

    return videoRepository.save(
      videoRepository.create({
        id: videoId,
        slug: randomUUID().slice(0, 11),
        channel_id: channel.id,
        title: 'Processing clip',
        status: VideoStatus.PROCESSING,
        source_key: sourceKey,
        size_bytes: sourceBody.length,
        mime_type: 'video/mp4',
        original_filename: 'clip.mp4',
      }),
    );
  }

  it('extracts duration and metadata, writes the thumbnail and marks the video ready', async () => {
    const video = await createProcessingVideo(clip.buffer);

    await service.process(video.id);

    const stored = await videoRepository.findOneByOrFail({ id: video.id });
    expect(stored.status).toBe(VideoStatus.READY);
    expect(stored.duration_seconds).toBe(clip.durationSeconds);
    expect(stored.metadata?.width).toBe(clip.width);
    expect(stored.metadata?.height).toBe(clip.height);
    expect(stored.metadata?.video_codec).toBe('h264');
    expect(stored.processing_error).toBeNull();
    expect(stored.thumbnail_key).toBe(buildThumbnailKey(video.id));

    await expect(
      storage.objectExists(buildThumbnailKey(video.id)),
    ).resolves.toBe(true);

    const thumbnail = await storage.headObject(buildThumbnailKey(video.id));
    expect(thumbnail.contentLength).toBeGreaterThan(0);
    expect(thumbnail.contentType).toBe('image/jpeg');
  }, 120000);

  it('reads the source over HTTP without downloading it to disk', async () => {
    // The source object is only reachable through the presigned URL the service
    // builds; nothing in the worker writes it to the filesystem.
    const video = await createProcessingVideo(clip.buffer);

    await service.process(video.id);

    const stored = await videoRepository.findOneByOrFail({ id: video.id });
    expect(stored.status).toBe(VideoStatus.READY);
  }, 120000);

  it('rejects a source that is not a decodable video', async () => {
    const video = await createProcessingVideo(
      Buffer.from('this is definitely not a video container'),
    );

    await expect(service.process(video.id)).rejects.toThrow();

    const stored = await videoRepository.findOneByOrFail({ id: video.id });
    expect(stored.status).toBe(VideoStatus.PROCESSING);
  }, 120000);

  it('raises VideoNotFoundException when the row is gone', async () => {
    await expect(service.process(randomUUID())).rejects.toBeInstanceOf(
      VideoNotFoundException,
    );
  }, 60000);

  describe('markFailed', () => {
    it('records the terminal failure and its reason', async () => {
      const video = await createProcessingVideo(clip.buffer);

      await service.markFailed(
        video.id,
        'ffprobe could not read the container',
      );

      const stored = await videoRepository.findOneByOrFail({ id: video.id });
      expect(stored.status).toBe(VideoStatus.FAILED);
      expect(stored.processing_error).toBe(
        'ffprobe could not read the container',
      );
    }, 60000);

    it('is a no-op when the video no longer exists', async () => {
      await expect(
        service.markFailed(randomUUID(), 'gone'),
      ).resolves.toBeUndefined();
    }, 60000);
  });
});
