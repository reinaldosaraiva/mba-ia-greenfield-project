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
  UnsupportedVideoTypeException,
  VideoNotFoundException,
  VideoTooLargeException,
  VideoUploadNotPendingException,
} from '../common/exceptions/domain.exception';
import videoConfig from '../config/video.config';
import { buildSourceKey } from '../storage/object-key.util';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import { generateVideoSlug } from './video-slug.util';
import {
  VIDEO_MAX_PARTS,
  VIDEO_PROCESSING_JOB,
  VIDEO_PROCESSING_QUEUE,
  VIDEO_SLUG_MAX_ATTEMPTS,
  VideoStatus,
} from './videos.constants';
import type {
  CreatedVideo,
  PresignedPart,
  VideoProcessingJobData,
  VideoUploadStatus,
} from './videos.types';

const SLUG_COLUMN = 'slug';

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

    await this.storageService.completeMultipartUpload(
      video.source_key,
      video.upload_id as string,
      dto.parts.map((part) => ({
        partNumber: part.part_number,
        etag: part.etag,
      })),
    );

    // The client declared a size at creation; storage knows the real one.
    const stored = await this.storageService.headObject(video.source_key);

    video.status = VideoStatus.PROCESSING;
    video.size_bytes = stored.contentLength;
    video.upload_id = null;
    await this.videoRepository.save(video);

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
