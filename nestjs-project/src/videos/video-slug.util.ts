import { randomBytes } from 'node:crypto';
import { VIDEO_SLUG_BYTES } from './videos.constants';

// 8 random bytes encode to exactly 11 base64url characters (~2^64 space), which
// is the short, opaque public identifier decided in phase-03-videos/TD-07.
export function generateVideoSlug(): string {
  return randomBytes(VIDEO_SLUG_BYTES).toString('base64url');
}
