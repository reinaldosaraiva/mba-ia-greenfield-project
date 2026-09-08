import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { VideoNotFoundException } from '../../common/exceptions/domain.exception';
import type { VideoProcessingJobData } from '../videos.types';
import { VideoProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

const VIDEO_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

function makeJob(
  attemptsMade: number,
  attempts = 3,
): Job<VideoProcessingJobData> {
  return {
    data: { videoId: VIDEO_ID },
    opts: { attempts },
    attemptsMade,
  } as unknown as Job<VideoProcessingJobData>;
}

describe('VideoProcessor', () => {
  let processingService: { process: jest.Mock; markFailed: jest.Mock };
  let processor: VideoProcessor;

  beforeEach(() => {
    processingService = {
      process: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    processor = new VideoProcessor(
      processingService as unknown as VideoProcessingService,
    );
  });

  describe('process', () => {
    it('delegates the job to the processing service', async () => {
      await processor.process(makeJob(0));

      expect(processingService.process).toHaveBeenCalledWith(VIDEO_ID);
    });

    it('skips the retry budget when the video no longer exists', async () => {
      processingService.process.mockRejectedValue(new VideoNotFoundException());

      await expect(processor.process(makeJob(0))).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
    });

    it('rethrows any other failure so BullMQ can retry it', async () => {
      processingService.process.mockRejectedValue(new Error('ffmpeg exploded'));

      await expect(processor.process(makeJob(0))).rejects.toThrow(
        'ffmpeg exploded',
      );
    });
  });

  describe('onFailed', () => {
    it('does not mark the video failed while attempts remain', async () => {
      await processor.onFailed(makeJob(1), new Error('transient'));

      expect(processingService.markFailed).not.toHaveBeenCalled();
    });

    it('marks the video failed once the retry budget is exhausted', async () => {
      await processor.onFailed(makeJob(3), new Error('ffprobe failed'));

      expect(processingService.markFailed).toHaveBeenCalledWith(
        VIDEO_ID,
        'ffprobe failed',
      );
    });

    it('marks the video failed immediately on an unrecoverable error', async () => {
      await processor.onFailed(
        makeJob(1),
        new UnrecoverableError('video is gone'),
      );

      expect(processingService.markFailed).toHaveBeenCalledWith(
        VIDEO_ID,
        'video is gone',
      );
    });

    it('ignores a failure event with no job attached', async () => {
      await processor.onFailed(undefined, new Error('detached'));

      expect(processingService.markFailed).not.toHaveBeenCalled();
    });
  });
});
