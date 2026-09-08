import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isUniqueViolationOnColumn } from '../common/database/pg-error.util';
import {
  ChannelNotFoundException,
  InvalidRangeException,
  InvalidUploadPartException,
  ThumbnailNotAvailableException,
  UnsupportedVideoTypeException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoTooLargeException,
  VideoUploadNotPendingException,
} from '../common/exceptions/domain.exception';
import videoConfig from '../config/video.config';
import { buildSourceKey } from '../storage/object-key.util';
import type { ObjectStream } from '../storage/storage.service';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import { parseRangeHeader } from './range.util';
import { generateVideoSlug } from './video-slug.util';
import {
  VIDEO_MAX_PARTS,
  VIDEO_PROCESSING_JOB,
  VIDEO_SOURCE_PREFIX,
  VIDEO_PROCESSING_QUEUE,
  VIDEO_SLUG_MAX_ATTEMPTS,
  VideoStatus,
} from './videos.constants';
import type {
  CreatedVideo,
  PresignedPart,
  VideoProcessingJobData,
  VideoStreamResult,
  VideoUploadStatus,
} from './videos.types';

const SLUG_COLUMN = 'slug';
const NO_SUCH_UPLOAD = 'NoSuchUpload';

function isNoSuchUpload(error: unknown): boolean {
  return (error as { name?: string }).name === NO_SUCH_UPLOAD;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue<VideoProcessingJobData>,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async createDraft(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreatedVideo> {
    const partCount = Math.ceil(
      dto.size_bytes / this.config.uploadPartSizeBytes,
    );

    if (
      dto.size_bytes > this.config.maxUploadBytes ||
      partCount > VIDEO_MAX_PARTS
    ) {
      throw new VideoTooLargeException();
    }

    if (!this.config.allowedMimeTypes.includes(dto.mime_type)) {
      throw new UnsupportedVideoTypeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const videoId = randomUUID();
    const sourceKey = buildSourceKey(videoId, dto.filename);
    const uploadId = await this.storageService.createMultipartUpload(
      sourceKey,
      dto.mime_type,
    );

    try {
      const video = await this.persistDraft({
        id: videoId,
        channel_id: channel.id,
        title: dto.title,
        source_key: sourceKey,
        upload_id: uploadId,
        size_bytes: dto.size_bytes,
        mime_type: dto.mime_type,
        original_filename: dto.filename,
      });

      return {
        id: video.id,
        slug: video.slug,
        status: video.status,
        upload: {
          upload_id: uploadId,
          part_size: this.config.uploadPartSizeBytes,
          part_count: partCount,
        },
      };
    } catch (error) {
      // The multipart upload is already open in storage; leaving it behind
      // would bill for parts nobody can complete.
      await this.storageService.abortMultipartUpload(sourceKey, uploadId);
      throw error;
    }
  }

  async presignParts(
    userId: string,
    videoId: string,
    partNumbers: number[],
  ): Promise<PresignedPart[]> {
    const video = await this.findPendingUploadForOwner(userId, videoId);
    const expiresIn = this.config.uploadUrlExpirationSeconds;

    // The declared size fixes how many parts this upload can have. Without this
    // bound a caller could presign parts 1..10000 for a one-part draft and write
    // far more than the size limit allows.
    const maxPartNumber = this.partCountFor(video.size_bytes);
    if (partNumbers.some((partNumber) => partNumber > maxPartNumber)) {
      throw new InvalidUploadPartException(maxPartNumber);
    }

    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.presignUploadPart(
          video.source_key,
          video.upload_id as string,
          partNumber,
          expiresIn,
        ),
        expires_in: expiresIn,
      })),
    );
  }

  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<VideoUploadStatus> {
    const video = await this.findPendingUploadForOwner(userId, videoId);
    const uploadId = video.upload_id as string;

    // Claiming the transition in one conditional UPDATE serialises concurrent
    // completions: the loser sees zero affected rows and gets the same 409 a
    // sequential second call would get.
    const claim = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      { status: VideoStatus.PROCESSING },
    );
    if (!claim.affected) {
      throw new VideoUploadNotPendingException();
    }

    try {
      await this.storageService.completeMultipartUpload(
        video.source_key,
        uploadId,
        dto.parts.map((part) => ({
          partNumber: part.part_number,
          etag: part.etag,
        })),
      );
    } catch (error) {
      // Nothing was stored, so the draft is still completable — hand it back.
      await this.videoRepository.update(
        { id: video.id },
        { status: VideoStatus.DRAFT },
      );
      if (isNoSuchUpload(error)) {
        throw new VideoUploadNotPendingException();
      }
      throw error;
    }

    // The client declared a size at creation; storage knows the real one.
    const stored = await this.storageService.headObject(video.source_key);

    if (stored.contentLength > this.config.maxUploadBytes) {
      await this.storageService.deletePrefix(
        `${VIDEO_SOURCE_PREFIX}/${video.id}/`,
      );
      await this.videoRepository.update(
        { id: video.id },
        {
          status: VideoStatus.FAILED,
          upload_id: null,
          processing_error: 'Uploaded bytes exceed the maximum allowed size',
        },
      );
      throw new VideoTooLargeException();
    }

    video.status = VideoStatus.PROCESSING;
    video.size_bytes = stored.contentLength;
    video.upload_id = null;
    await this.videoRepository.save(video);

    try {
      await this.processingQueue.add(
        VIDEO_PROCESSING_JOB,
        { videoId: video.id },
        {
          // Keying the job by video id makes a repeated completion a no-op
          // instead of a second unit of the same work.
          jobId: video.id,
          attempts: this.config.processingAttempts,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
        },
      );
    } catch (error) {
      // Without this the video would sit in `processing` forever, waiting for a
      // job nobody published.
      await this.videoRepository.update(
        { id: video.id },
        {
          status: VideoStatus.FAILED,
          processing_error: `Could not enqueue the processing job: ${(error as Error).message}`,
        },
      );
      throw error;
    }

    return { id: video.id, slug: video.slug, status: video.status };
  }

  async abortUpload(userId: string, videoId: string): Promise<void> {
    const video = await this.findPendingUploadForOwner(userId, videoId);

    await this.storageService.abortMultipartUpload(
      video.source_key,
      video.upload_id as string,
    );
    await this.videoRepository.delete({ id: video.id });
  }

  async findBySlugForOwner(userId: string, slug: string): Promise<Video> {
    return this.findOwnedVideo(userId, { slug });
  }

  async readThumbnail(userId: string, slug: string): Promise<ObjectStream> {
    const video = await this.findOwnedVideo(userId, { slug });

    if (!video.thumbnail_key) {
      throw new ThumbnailNotAvailableException();
    }

    return this.storageService.getObjectRange(video.thumbnail_key);
  }

  async openStream(
    userId: string,
    slug: string,
    rangeHeader: string | undefined,
  ): Promise<VideoStreamResult> {
    const video = await this.findReadyVideo(userId, slug);
    const head = await this.storageService.headObject(video.source_key);
    const requested = parseRangeHeader(rangeHeader, head.contentLength);

    if (requested.kind === 'unsatisfiable') {
      throw new InvalidRangeException(head.contentLength);
    }

    const range = requested.kind === 'partial' ? requested.range : null;
    const object = await this.storageService.getObjectRange(
      video.source_key,
      range ?? undefined,
    );

    return {
      video,
      body: object.body,
      contentType: object.contentType ?? video.mime_type,
      contentLength: object.contentLength,
      totalSize: head.contentLength,
      range,
    };
  }

  async openDownload(userId: string, slug: string): Promise<VideoStreamResult> {
    const video = await this.findReadyVideo(userId, slug);
    const head = await this.storageService.headObject(video.source_key);
    const object = await this.storageService.getObjectRange(video.source_key);

    return {
      video,
      body: object.body,
      contentType: object.contentType ?? video.mime_type,
      contentLength: object.contentLength,
      totalSize: head.contentLength,
      range: null,
    };
  }

  private async findReadyVideo(userId: string, slug: string): Promise<Video> {
    const video = await this.findOwnedVideo(userId, { slug });

    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }

    return video;
  }

  private partCountFor(sizeBytes: number): number {
    return Math.ceil(sizeBytes / this.config.uploadPartSizeBytes);
  }

  private async persistDraft(draft: Partial<Video>): Promise<Video> {
    let lastError: unknown;

    for (let attempt = 0; attempt < VIDEO_SLUG_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            ...draft,
            slug: generateVideoSlug(),
            status: VideoStatus.DRAFT,
          }),
        );
      } catch (error) {
        if (!isUniqueViolationOnColumn(error, SLUG_COLUMN)) {
          throw error;
        }
        lastError = error;
      }
    }

    throw lastError;
  }

  private async findPendingUploadForOwner(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.findOwnedVideo(userId, { id: videoId });

    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoUploadNotPendingException();
    }

    return video;
  }

  private async findOwnedVideo(
    userId: string,
    where: { id: string } | { slug: string },
  ): Promise<Video> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    const video = await this.videoRepository.findOne({ where });

    // A video owned by another channel answers exactly like an unknown one so
    // existence is never disclosed.
    if (!video || video.channel_id !== channel.id) {
      throw new VideoNotFoundException();
    }

    return video;
  }
}
