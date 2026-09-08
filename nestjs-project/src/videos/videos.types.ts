import type { Readable } from 'node:stream';
import type { Video } from './entities/video.entity';
import type { ResolvedRange } from './range.util';
import type { VideoStatus } from './videos.constants';

export interface VideoUploadEnvelope {
  upload_id: string;
  part_size: number;
  part_count: number;
}

export interface CreatedVideo {
  id: string;
  slug: string;
  status: VideoStatus;
  upload: VideoUploadEnvelope;
}

export interface PresignedPart {
  part_number: number;
  url: string;
  expires_in: number;
}

export interface VideoUploadStatus {
  id: string;
  slug: string;
  status: VideoStatus;
}

export interface VideoProcessingJobData {
  videoId: string;
}

export interface VideoStreamResult {
  video: Video;
  body: Readable;
  contentType: string;
  contentLength: number;
  totalSize: number;
  range: ResolvedRange | null;
}
