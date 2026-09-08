import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { VideoNotFoundException } from '../../common/exceptions/domain.exception';
import { VIDEO_PROCESSING_QUEUE } from '../videos.constants';
import type { VideoProcessingJobData } from '../videos.types';
import { VideoProcessingService } from './video-processing.service';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(private readonly processingService: VideoProcessingService) {
    super();
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    try {
      await this.processingService.process(job.data.videoId);
    } catch (error) {
      // A job whose video row is gone can never succeed, so it skips the
      // remaining retry budget instead of burning worker capacity.
      if (error instanceof VideoNotFoundException) {
        throw new UnrecoverableError(
          `Video ${job.data.videoId} no longer exists`,
        );
      }
      throw error;
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoProcessingJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) {
      return;
    }

    const budget = job.opts.attempts ?? 1;
    const exhausted =
      error instanceof UnrecoverableError || job.attemptsMade >= budget;

    if (!exhausted) {
      this.logger.warn(
        `Video ${job.data.videoId} processing attempt ${job.attemptsMade}/${budget} failed: ${error.message}`,
      );
      return;
    }

    await this.processingService.markFailed(job.data.videoId, error.message);
  }
}
