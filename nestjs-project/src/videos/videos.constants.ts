export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const VIDEO_PROCESSING_JOB = 'process-video';

export const VIDEO_SOURCE_PREFIX = 'videos';
export const VIDEO_THUMBNAIL_PREFIX = 'thumbnails';
export const VIDEO_THUMBNAIL_FILENAME = 'thumbnail.jpg';
export const VIDEO_THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

export const VIDEO_SLUG_BYTES = 8;
export const VIDEO_SLUG_LENGTH = 11;
export const VIDEO_SLUG_MAX_ATTEMPTS = 5;

export const VIDEO_MAX_PARTS = 10000;
export const VIDEO_MAX_PARTS_PER_REQUEST = 100;

export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}
