import type { Video } from './entities/video.entity';

const UNSAFE_CHARACTERS = /["\\\r\n/]/g;
const DEFAULT_EXTENSION = 'mp4';
const MAX_BASENAME_LENGTH = 100;

// The filename lands inside a quoted `Content-Disposition` value, so quotes,
// backslashes, separators and control characters must not survive.
export function downloadFilename(video: Video): string {
  const base =
    video.title
      .replace(UNSAFE_CHARACTERS, '')
      .trim()
      .slice(0, MAX_BASENAME_LENGTH) || video.slug;

  const sourceExtension = video.source_key.split('.').pop();
  const extension =
    sourceExtension && /^[a-z0-9]{1,5}$/.test(sourceExtension)
      ? sourceExtension
      : DEFAULT_EXTENSION;

  return `${base}.${extension}`;
}
