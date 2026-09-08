import { registerAs } from '@nestjs/config';

const DEFAULT_ALLOWED_MIME_TYPES =
  'video/mp4,video/quicktime,video/webm,video/x-matroska';

export default registerAs('video', () => ({
  maxUploadBytes: parseInt(
    process.env.VIDEO_MAX_UPLOAD_BYTES || '10737418240',
    10,
  ),
  uploadPartSizeBytes: parseInt(
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES || '10485760',
    10,
  ),
  uploadUrlExpirationSeconds: parseInt(
    process.env.VIDEO_UPLOAD_URL_EXPIRATION_SECONDS || '3600',
    10,
  ),
  processingUrlExpirationSeconds: parseInt(
    process.env.VIDEO_PROCESSING_URL_EXPIRATION_SECONDS || '900',
    10,
  ),
  processingAttempts: parseInt(
    process.env.VIDEO_PROCESSING_ATTEMPTS || '3',
    10,
  ),
  thumbnailPositionRatio: parseFloat(
    process.env.VIDEO_THUMBNAIL_POSITION_RATIO || '0.1',
  ),
  allowedMimeTypes: (
    process.env.VIDEO_ALLOWED_MIME_TYPES || DEFAULT_ALLOWED_MIME_TYPES
  )
    .split(',')
    .map((type) => type.trim())
    .filter((type) => type.length > 0),
}));
