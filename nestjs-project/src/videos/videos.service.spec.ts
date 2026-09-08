import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  UnsupportedVideoTypeException,
  VideoNotFoundException,
  VideoTooLargeException,
  VideoUploadNotPendingException,
} from '../common/exceptions/domain.exception';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './videos.constants';
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
    presignUploadPart: jest.Mock;
  };

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
      presignUploadPart: jest
        .fn()
        .mockImplementation((_key, _upload, partNumber: number) =>
          Promise.resolve(`https://storage.local/part/${partNumber}`),
        ),
    };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
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
