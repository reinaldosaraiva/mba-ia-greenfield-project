import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import {
  ALL_ENTITIES,
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { VideoStatus } from '../videos.constants';
import { Video } from './video.entity';

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const suffix = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_owner_${suffix}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `chan${suffix}`,
        nickname: `chan_${suffix}_${Date.now()}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(
    channelId: string,
    overrides: Partial<Video> = {},
  ): Video {
    return videoRepository.create({
      slug: `slug${Math.random().toString(36).slice(2, 10)}`,
      channel_id: channelId,
      title: 'My video',
      source_key: 'videos/x/source.mp4',
      size_bytes: 1024,
      mime_type: 'video/mp4',
      original_filename: 'my-video.mp4',
      ...overrides,
    });
  }

  it('should default status to draft', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(buildVideo(channel.id));

    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('should enforce the unique slug constraint', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel.id, { slug: 'duplicated1' }));

    await expect(
      videoRepository.save(buildVideo(channel.id, { slug: 'duplicated1' })),
    ).rejects.toThrow();
  });

  it('should reject a status outside the enum', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(buildVideo(channel.id));

    await expect(
      dataSource.query(
        `UPDATE "videos" SET "status" = 'archived' WHERE id = $1`,
        [video.id],
      ),
    ).rejects.toThrow();
  });

  it('should reject a channel_id with no matching channel', async () => {
    await expect(
      videoRepository.save(buildVideo('11111111-1111-1111-1111-111111111111')),
    ).rejects.toThrow();
  });

  it('should leave the worker-owned columns null until processing runs', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(buildVideo(channel.id));

    expect(video.thumbnail_key).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.metadata).toBeNull();
    expect(video.processing_error).toBeNull();
  });

  it('should round-trip size_bytes above the 32-bit range as a number', async () => {
    const channel = await createChannel();
    const tenGiB = 10 * 1024 * 1024 * 1024;

    const saved = await videoRepository.save(
      buildVideo(channel.id, { size_bytes: tenGiB }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.size_bytes).toBe(tenGiB);
    expect(typeof found.size_bytes).toBe('number');
  });

  it('should persist the ffprobe metadata as jsonb', async () => {
    const channel = await createChannel();
    const metadata = { width: 640, height: 480, video_codec: 'h264' };

    const saved = await videoRepository.save(
      buildVideo(channel.id, { metadata }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.metadata).toEqual(metadata);
  });

  it('should load the owning channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(buildVideo(channel.id));

    const found = await videoRepository.findOne({
      where: { id: saved.id },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });
});
