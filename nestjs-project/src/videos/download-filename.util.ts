import type { Video } from './entities/video.entity';

const NON_ASCII_OR_UNSAFE = /[^\x20-\x7E]|["\\/]/g;
const DEFAULT_EXTENSION = 'mp4';
const MAX_BASENAME_LENGTH = 100;

function extensionOf(video: Video): string {
  const candidate = video.source_key.split('.').pop();
  return candidate && /^[a-z0-9]{1,5}$/.test(candidate)
    ? candidate
    : DEFAULT_EXTENSION;
}

// The ASCII form is what old clients read out of the quoted `filename`; anything
// outside printable ASCII is dropped there because Node rejects non-Latin-1
// header values, and `setHeader` would throw after the response has started.
export function downloadFilename(video: Video): string {
  const base =
    video.title
      .replace(NON_ASCII_OR_UNSAFE, '')
      .trim()
      .slice(0, MAX_BASENAME_LENGTH) || video.slug;

  return `${base}.${extensionOf(video)}`;
}

// RFC 6266 §4.1: `filename*` carries the real UTF-8 name for clients that
// understand it, `filename` stays as the ASCII fallback.
export function contentDispositionAttachment(video: Video): string {
  const utf8Name = `${
    video.title
      .replace(/[\r\n"\\/]/g, '')
      .trim()
      .slice(0, MAX_BASENAME_LENGTH) || video.slug
  }.${extensionOf(video)}`;

  return [
    'attachment',
    `filename="${downloadFilename(video)}"`,
    `filename*=UTF-8''${encodeURIComponent(utf8Name)}`,
  ].join('; ');
}
