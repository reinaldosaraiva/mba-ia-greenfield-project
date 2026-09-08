import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../../storage/storage.module';
import { Video } from '../entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../videos.constants';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    StorageModule,
  ],
  providers: [FfmpegService, VideoProcessingService, VideoProcessor],
  exports: [FfmpegService, VideoProcessingService],
})
export class VideoProcessingModule {}
