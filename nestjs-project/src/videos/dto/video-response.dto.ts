import { ApiProperty } from '@nestjs/swagger';
import type { Video, VideoMetadata } from '../entities/video.entity';
import { VideoStatus } from '../videos.constants';

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    example: 'Kx7mQ2rTb9A',
    description: 'Unique public identifier',
  })
  slug: string;

  @ApiProperty({ example: 'My holiday clip' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.READY })
  status: VideoStatus;

  @ApiProperty({ example: 42278, description: 'Size stored in object storage' })
  size_bytes: number;

  @ApiProperty({ example: 'video/mp4' })
  mime_type: string;

  @ApiProperty({ example: 'holiday.mp4' })
  original_filename: string;

  @ApiProperty({
    required: false,
    nullable: true,
    example: 3,
    description: 'Filled by the worker once processing completes',
  })
  duration_seconds: number | null;

  @ApiProperty({
    required: false,
    nullable: true,
    type: Object,
    additionalProperties: true,
    description: 'ffprobe-derived metadata; null until processing completes',
  })
  metadata: VideoMetadata | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Reason recorded when processing ends in failure',
  })
  processing_error: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at: Date;

  @ApiProperty({ format: 'date-time' })
  updated_at: Date;
}

export function toVideoResponse(video: Video): VideoResponseDto {
  return {
    id: video.id,
    slug: video.slug,
    title: video.title,
    status: video.status,
    size_bytes: video.size_bytes,
    mime_type: video.mime_type,
    original_filename: video.original_filename,
    duration_seconds: video.duration_seconds,
    metadata: video.metadata,
    processing_error: video.processing_error,
    created_at: video.created_at,
    updated_at: video.updated_at,
  };
}
