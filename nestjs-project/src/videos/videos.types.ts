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
