import {
  VIDEO_SOURCE_PREFIX,
  VIDEO_THUMBNAIL_FILENAME,
  VIDEO_THUMBNAIL_PREFIX,
} from '../videos/videos.constants';
import {
  STORAGE_ALLOWED_EXTENSIONS,
  STORAGE_DEFAULT_EXTENSION,
} from './storage.constants';

function extensionOf(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === filename.length - 1) {
    return STORAGE_DEFAULT_EXTENSION;
  }

  const extension = filename.slice(lastDot).toLowerCase();
  return (STORAGE_ALLOWED_EXTENSIONS as readonly string[]).includes(extension)
    ? extension
    : STORAGE_DEFAULT_EXTENSION;
}

export function buildSourceKey(videoId: string, filename: string): string {
  return `${VIDEO_SOURCE_PREFIX}/${videoId}/source${extensionOf(filename)}`;
}

export function buildThumbnailKey(videoId: string): string {
  return `${VIDEO_THUMBNAIL_PREFIX}/${videoId}/${VIDEO_THUMBNAIL_FILENAME}`;
}

export function buildVideoPrefixes(videoId: string): string[] {
  return [
    `${VIDEO_SOURCE_PREFIX}/${videoId}/`,
    `${VIDEO_THUMBNAIL_PREFIX}/${videoId}/`,
  ];
}
