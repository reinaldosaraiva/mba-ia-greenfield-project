import {
  buildSourceKey,
  buildThumbnailKey,
  buildVideoPrefixes,
} from './object-key.util';

const VIDEO_ID = '8f6b0a2c-2f3e-4e0e-9a2a-3c9b6f1d0f11';

describe('object-key util', () => {
  describe('buildSourceKey', () => {
    it('namespaces the source object under the video id', () => {
      expect(buildSourceKey(VIDEO_ID, 'holiday.mp4')).toBe(
        `videos/${VIDEO_ID}/source.mp4`,
      );
    });

    it('keeps an allowed extension and lowercases it', () => {
      expect(buildSourceKey(VIDEO_ID, 'clip.MOV')).toBe(
        `videos/${VIDEO_ID}/source.mov`,
      );
    });

    it('falls back to the default extension for an unknown one', () => {
      expect(buildSourceKey(VIDEO_ID, 'payload.exe')).toBe(
        `videos/${VIDEO_ID}/source.mp4`,
      );
    });

    it('falls back to the default extension when the filename has none', () => {
      expect(buildSourceKey(VIDEO_ID, 'noextension')).toBe(
        `videos/${VIDEO_ID}/source.mp4`,
      );
    });

    it('ignores a dotfile name with no real extension', () => {
      expect(buildSourceKey(VIDEO_ID, '.mp4')).toBe(
        `videos/${VIDEO_ID}/source.mp4`,
      );
    });

    it('never lets the filename influence the key path', () => {
      const key = buildSourceKey(VIDEO_ID, '../../etc/passwd.mp4');

      expect(key).toBe(`videos/${VIDEO_ID}/source.mp4`);
      expect(key).not.toContain('..');
    });
  });

  describe('buildThumbnailKey', () => {
    it('namespaces the thumbnail under the video id', () => {
      expect(buildThumbnailKey(VIDEO_ID)).toBe(
        `thumbnails/${VIDEO_ID}/thumbnail.jpg`,
      );
    });
  });

  describe('buildVideoPrefixes', () => {
    it('returns both prefixes owned by a video', () => {
      expect(buildVideoPrefixes(VIDEO_ID)).toEqual([
        `videos/${VIDEO_ID}/`,
        `thumbnails/${VIDEO_ID}/`,
      ]);
    });
  });
});
