import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VideoNotFoundException } from '../../common/exceptions/domain.exception';
import videoConfig from '../../config/video.config';
import { buildThumbnailKey } from '../../storage/object-key.util';
import { StorageService } from '../../storage/storage.service';
import { Video } from '../entities/video.entity';
import { VIDEO_THUMBNAIL_CONTENT_TYPE, VideoStatus } from '../videos.constants';
import { FfmpegService } from './ffmpeg.service';
import { thumbnailPosition } from './thumbnail-position.util';

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async process(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    const sourceUrl = await this.storageService.presignGetObject(
      video.source_key,
      this.config.processingUrlExpirationSeconds,
    );

    const probe = await this.ffmpegService.probe(sourceUrl);
    const position = thumbnailPosition(
      probe.durationSeconds,
      this.config.thumbnailPositionRatio,
    );
    const thumbnail = await this.ffmpegService.extractThumbnail(
      sourceUrl,
      position,
    );

    const thumbnailKey = buildThumbnailKey(video.id);
    await this.storageService.putObject(
      thumbnailKey,
      thumbnail,
      VIDEO_THUMBNAIL_CONTENT_TYPE,
    );

    video.duration_seconds = probe.durationSeconds;
    video.metadata = probe.metadata;
    video.thumbnail_key = thumbnailKey;
    video.status = VideoStatus.READY;
    video.processing_error = null;
    await this.videoRepository.save(video);

    this.logger.log(`Video ${video.id} processed and marked ready`);
  }

  async markFailed(videoId: string, reason: string): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });

    if (!video) {
      return;
    }

    video.status = VideoStatus.FAILED;
    video.processing_error = reason;
    await this.videoRepository.save(video);

    this.logger.warn(`Video ${video.id} marked failed: ${reason}`);
  }
}
