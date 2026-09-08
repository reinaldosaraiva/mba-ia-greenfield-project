import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import {
  ALL_ENTITIES,
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoStatus } from './videos.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const MIN_PART_SIZE = 5 * 1024 * 1024;

const DRAFT_INPUT = {
  title: 'Integration clip',
  filename: 'clip.mp4',
  size_bytes: 20 * 1024 * 1024,
  mime_type: 'video/mp4',
};

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  const touchedKeys: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();
    await module.init();

    service = module.get(VideosService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  }, 60000);

  afterAll(async () => {
    for (const key of touchedKeys) {
      await storage.deletePrefix(key);
    }
    await module.close();
  }, 60000);

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createOwner(): Promise<{ userId: string; channelId: string }> {
    const suffix = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_it_${suffix}_${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `chan${suffix}`,
        nickname: `videos_it_${suffix}_${Date.now()}`,
        user_id: user.id,
      }),
    );
    return { userId: user.id, channelId: channel.id };
  }

  it('pre-registers the video as a draft and opens a real multipart upload', async () => {
    const { userId, channelId } = await createOwner();

    const created = await service.createDraft(userId, DRAFT_INPUT);
    touchedKeys.push(`videos/${created.id}/`);

    const stored = await videoRepository.findOneByOrFail({ id: created.id });
    expect(stored.status).toBe(VideoStatus.DRAFT);
    expect(stored.channel_id).toBe(channelId);
    expect(stored.slug).toBe(created.slug);
    expect(stored.source_key).toBe(`videos/${created.id}/source.mp4`);
    expect(stored.upload_id).toBe(created.upload.upload_id);

    // A presigned part that uploads proves the multipart upload really exists.
    const [part] = await service.presignParts(userId, created.id, [1]);
    const response = await fetch(part.url, {
      method: 'PUT',
      body: Buffer.alloc(MIN_PART_SIZE, 'a'),
    });
    expect(response.status).toBe(200);

    await service.abortUpload(userId, created.id);
  }, 60000);

  it('removes the draft and the pending upload when the upload is aborted', async () => {
    const { userId } = await createOwner();
    const created = await service.createDraft(userId, DRAFT_INPUT);
    touchedKeys.push(`videos/${created.id}/`);

    await service.abortUpload(userId, created.id);

    await expect(
      videoRepository.findOneBy({ id: created.id }),
    ).resolves.toBeNull();
    await expect(
      storage.objectExists(`videos/${created.id}/source.mp4`),
    ).resolves.toBe(false);

    const [part] = [
      {
        url: await storage.presignUploadPart(
          `videos/${created.id}/source.mp4`,
          created.upload.upload_id,
          1,
          600,
        ),
      },
    ];
    const response = await fetch(part.url, {
      method: 'PUT',
      body: Buffer.from('x'),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  }, 60000);

  it('never exposes a draft that belongs to another channel', async () => {
    const owner = await createOwner();
    const stranger = await createOwner();
    const created = await service.createDraft(owner.userId, DRAFT_INPUT);
    touchedKeys.push(`videos/${created.id}/`);

    await expect(
      service.presignParts(stranger.userId, created.id, [1]),
    ).rejects.toBeInstanceOf(VideoNotFoundException);

    await service.abortUpload(owner.userId, created.id);
  }, 60000);

  it('assigns a distinct slug to every draft', async () => {
    const { userId } = await createOwner();

    const first = await service.createDraft(userId, DRAFT_INPUT);
    const second = await service.createDraft(userId, DRAFT_INPUT);
    touchedKeys.push(`videos/${first.id}/`, `videos/${second.id}/`);

    expect(first.slug).not.toBe(second.slug);

    await service.abortUpload(userId, first.id);
    await service.abortUpload(userId, second.id);
  }, 60000);
});
