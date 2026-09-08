import { Test } from '@nestjs/testing';
import { VideoProcessingService } from '../videos/processing/video-processing.service';
import { VideoProcessor } from '../videos/processing/video-processing.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile as a standalone application context with the processor wired', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessingService)).toBeInstanceOf(
      VideoProcessingService,
    );
    expect(module.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
    await module.close();
  }, 60000);
});
