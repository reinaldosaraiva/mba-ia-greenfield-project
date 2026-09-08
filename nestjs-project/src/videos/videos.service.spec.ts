import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  ThumbnailNotAvailableException,
  UnsupportedVideoTypeException,
  VideoNotFoundException,
  VideoTooLargeException,
  VideoUploadNotPendingException,
} from '../common/exceptions/domain.exception';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE, VideoStatus } from './videos.constants';
import { VideosService } from './videos.service';

const CHANNEL_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const OTHER_CHANNEL_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const VIDEO_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const CONFIG = {
  maxUploadBytes: 10 * 1024 * 1024 * 1024,
  uploadPartSizeBytes: 10 * 1024 * 1024,
  uploadUrlExpirationSeconds: 3600,
  processingUrlExpirationSeconds: 900,
  processingAttempts: 3,
  thumbnailPositionRatio: 0.1,
  allowedMimeTypes: ['video/mp4'],
};

const VALID_DTO = {
  title: 'My video',
  filename: 'clip.mp4',
  size_bytes: 20 * 1024 * 1024,
  mime_type: 'video/mp4',
};

function uniqueSlugViolation(): QueryFailedError {
  const driverError = new Error('duplicate key value') as Error & {
    code?: string;
    detail?: string;
  };
  driverError.code = '23505';
  driverError.detail = 'Key (slug)=(abc) already exists.';
  return new QueryFailedError('INSERT', [], driverError);
}

describe('VideosService', () => {
  let service: VideosService;
  let repository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    delete: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };
  let storageService: {
    createMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
    completeMultipartUpload: jest.Mock;
    headObject: jest.Mock;
    presignUploadPart: jest.Mock;
  };
  let processingQueue: { add: jest.Mock };

  beforeEach(async () => {
    repository = {
      create: jest.fn((value: Partial<Video>) => value as Video),
      save: jest.fn((value: Video) => Promise.resolve(value)),
      findOne: jest.fn(),
      delete: jest.fn(),
    };
    channelsService = {
      findByUserId: jest.fn().mockResolvedValue({ id: CHANNEL_ID }),
    };
    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue({ contentLength: 4242 }),
      presignUploadPart: jest
        .fn()
        .mockImplementation((_key, _upload, partNumber: number) =>
          Promise.resolve(`https://storage.local/part/${partNumber}`),
        ),
    };
    processingQueue = { add: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: processingQueue,
        },
        { provide: videoConfig.KEY, useValue: CONFIG },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('createDraft', () => {
    it('persists the video as a draft and returns the upload envelope', async () => {
      const result = await service.createDraft(USER_ID, VALID_DTO);

      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.slug).toHaveLength(11);
      expect(result.upload).toEqual({
        upload_id: 'upload-1',
        part_size: CONFIG.uploadPartSizeBytes,
        part_count: 2,
      });
      expect(repository.save).toHaveBeenCalledTimes(1);
    });

    it('rejects a declared size above the configured maximum', async () => {
      await expect(
        service.createDraft(USER_ID, {
          ...VALID_DTO,
          size_bytes: CONFIG.maxUploadBytes + 1,
        }),
      ).rejects.toBeInstanceOf(VideoTooLargeException);

      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('rejects a content type outside the allowlist', async () => {
      await expect(
        service.createDraft(USER_ID, {
          ...VALID_DTO,
          mime_type: 'application/pdf',
        }),
      ).rejects.toBeInstanceOf(UnsupportedVideoTypeException);

      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('rejects a user with no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(
        service.createDraft(USER_ID, VALID_DTO),
      ).rejects.toBeInstanceOf(ChannelNotFoundException);

      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('retries with a fresh slug on a unique violation', async () => {
      repository.save
        .mockRejectedValueOnce(uniqueSlugViolation())
        .mockImplementationOnce((value: Video) => Promise.resolve(value));

      const result = await service.createDraft(USER_ID, VALID_DTO);

      expect(repository.save).toHaveBeenCalledTimes(2);
      const firstSlug = (repository.save.mock.calls[0][0] as Video).slug;
      const secondSlug = (repository.save.mock.calls[1][0] as Video).slug;
      expect(firstSlug).not.toBe(secondSlug);
      expect(result.slug).toBe(secondSlug);
    });

    it('aborts the multipart upload when persistence fails', async () => {
      repository.save.mockRejectedValue(new Error('database is down'));

      await expect(service.createDraft(USER_ID, VALID_DTO)).rejects.toThrow(
        'database is down',
      );

      expect(storageService.abortMultipartUpload).toHaveBeenCalledTimes(1);
    });
  });

  describe('presignParts', () => {
    it('returns one presigned URL per requested part', async () => {
      repository.findOne.mockResolvedValue({
        id: VIDEO_ID,
        channel_id: CHANNEL_ID,
        status: VideoStatus.DRAFT,
        upload_id: 'upload-1',
        source_key: 'videos/x/source.mp4',
      });

      const parts = await service.presignParts(USER_ID, VIDEO_ID, [1, 2]);

      expect(parts).toEqual([
        {
          part_number: 1,
          url: 'https://storage.local/part/1',
          expires_in: CONFIG.uploadUrlExpirationSeconds,
        },
        {
          part_number: 2,
          url: 'https://storage.local/part/2',
          expires_in: CONFIG.uploadUrlExpirationSeconds,
        },
      ]);
    });

    it('answers a video owned by another channel as not found', async () => {
      repository.findOne.mockResolvedValue({
        id: VIDEO_ID,
        channel_id: OTHER_CHANNEL_ID,
        status: VideoStatus.DRAFT,
        upload_id: 'upload-1',
        source_key: 'videos/x/source.mp4',
      });

      await expect(
        service.presignParts(USER_ID, VIDEO_ID, [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('rejects a video whose upload is no longer pending', async () => {
      repository.findOne.mockResolvedValue({
        id: VIDEO_ID,
        channel_id: CHANNEL_ID,
        status: VideoStatus.PROCESSING,
        upload_id: null,
        source_key: 'videos/x/source.mp4',
      });

      await expect(
        service.presignParts(USER_ID, VIDEO_ID, [1]),
      ).rejects.toBeInstanceOf(VideoUploadNotPendingException);
    });
  });

  describe('completeUpload', () => {
    const pendingVideo = () => ({
      id: VIDEO_ID,
      slug: 'abcdefghijk',
      channel_id: CHANNEL_ID,
      status: VideoStatus.DRAFT,
      upload_id: 'upload-1',
      source_key: 'videos/x/source.mp4',
      size_bytes: 999,
    });

    it('forwards the parts sorted by part number', async () => {
      repository.findOne.mockResolvedValue(pendingVideo());

      await service.completeUpload(USER_ID, VIDEO_ID, {
        parts: [
          { part_number: 2, etag: 'two' },
          { part_number: 1, etag: 'one' },
        ],
      });

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/x/source.mp4',
        'upload-1',
        [
          { partNumber: 2, etag: 'two' },
          { partNumber: 1, etag: 'one' },
        ],
      );
    });

    it('moves the video to processing with the size reported by storage', async () => {
      repository.findOne.mockResolvedValue(pendingVideo());

      const result = await service.completeUpload(USER_ID, VIDEO_ID, {
        parts: [{ part_number: 1, etag: 'one' }],
      });

      expect(result.status).toBe(VideoStatus.PROCESSING);
      const saved = repository.save.mock.calls[0][0] as Video;
      expect(saved.status).toBe(VideoStatus.PROCESSING);
      expect(saved.size_bytes).toBe(4242);
      expect(saved.upload_id).toBeNull();
    });

    it('enqueues exactly one job keyed by the video id', async () => {
      repository.findOne.mockResolvedValue(pendingVideo());

      await service.completeUpload(USER_ID, VIDEO_ID, {
        parts: [{ part_number: 1, etag: 'one' }],
      });

      expect(processingQueue.add).toHaveBeenCalledTimes(1);
      const [, payload, options] = processingQueue.add.mock.calls[0] as [
        string,
        { videoId: string },
        { jobId: string; attempts: number },
      ];
      expect(payload).toEqual({ videoId: VIDEO_ID });
      expect(options.jobId).toBe(VIDEO_ID);
      expect(options.attempts).toBe(CONFIG.processingAttempts);
    });

    it('rejects a video whose upload is no longer pending', async () => {
      repository.findOne.mockResolvedValue({
        ...pendingVideo(),
        status: VideoStatus.PROCESSING,
        upload_id: null,
      });

      await expect(
        service.completeUpload(USER_ID, VIDEO_ID, {
          parts: [{ part_number: 1, etag: 'one' }],
        }),
      ).rejects.toBeInstanceOf(VideoUploadNotPendingException);

      expect(processingQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('findBySlugForOwner', () => {
    it('raises VideoNotFoundException for an unknown slug', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.findBySlugForOwner(USER_ID, 'unknownslug'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('raises VideoNotFoundException for a slug owned by another channel', async () => {
      repository.findOne.mockResolvedValue({
        id: VIDEO_ID,
        slug: 'otherslug1',
        channel_id: OTHER_CHANNEL_ID,
      });

      await expect(
        service.findBySlugForOwner(USER_ID, 'otherslug1'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('readThumbnail', () => {
    it('raises ThumbnailNotAvailableException before processing completes', async () => {
      repository.findOne.mockResolvedValue({
        id: VIDEO_ID,
        slug: 'pendingslu',
        channel_id: CHANNEL_ID,
        status: VideoStatus.PROCESSING,
        thumbnail_key: null,
      });

      await expect(
        service.readThumbnail(USER_ID, 'pendingslu'),
      ).rejects.toBeInstanceOf(ThumbnailNotAvailableException);
    });
  });

  describe('abortUpload', () => {
    it('aborts the storage upload and deletes the draft', async () => {
      repository.findOne.mockResolvedValue({
        id: VIDEO_ID,
        channel_id: CHANNEL_ID,
        status: VideoStatus.DRAFT,
        upload_id: 'upload-1',
        source_key: 'videos/x/source.mp4',
      });

      await service.abortUpload(USER_ID, VIDEO_ID);

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/x/source.mp4',
        'upload-1',
      );
      expect(repository.delete).toHaveBeenCalledWith({ id: VIDEO_ID });
    });
  });
});
