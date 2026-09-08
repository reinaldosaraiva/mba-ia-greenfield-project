import {
  FixtureServer,
  startFixtureServer,
} from '../../test/http-fixture-server';
import { generateVideoClip, GeneratedClip } from '../../test/video-fixture';
import { FfmpegService } from './ffmpeg.service';

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

// A playlist whose segment points at a local file: exactly the shape that would
// turn the worker into a local-file reader if the protocol whitelist were gone.
const MALICIOUS_PLAYLIST = Buffer.from(
  [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    '#EXTINF:10,',
    'file:///etc/passwd',
    '#EXT-X-ENDLIST',
  ].join('\n'),
);

describe('FfmpegService (integration)', () => {
  const service = new FfmpegService();
  let clip: GeneratedClip;
  let server: FixtureServer;

  beforeAll(async () => {
    clip = await generateVideoClip(3, 320, 240);
    server = await startFixtureServer({
      'clip.mp4': clip.buffer,
      'notes.txt': Buffer.from('this is not a video'),
      'evil.m3u8': MALICIOUS_PLAYLIST,
    });
  }, 60000);

  afterAll(async () => {
    await server.close();
    await clip.cleanup();
  });

  describe('probe', () => {
    it('reads duration, dimensions and codecs from a real clip over HTTP', async () => {
      const result = await service.probe(server.urlFor('clip.mp4'));

      expect(result.durationSeconds).toBe(clip.durationSeconds);
      expect(result.metadata.width).toBe(clip.width);
      expect(result.metadata.height).toBe(clip.height);
      expect(result.metadata.video_codec).toBe('h264');
      expect(result.metadata.audio_codec).toBe('aac');
      expect(result.metadata.format_name).toContain('mp4');
      expect(result.metadata.bit_rate).toBeGreaterThan(0);
    }, 60000);

    it('rejects an input with no video stream', async () => {
      await expect(service.probe(server.urlFor('notes.txt'))).rejects.toThrow();
    }, 60000);

    it('refuses to dereference a file:// reference embedded in the source', async () => {
      await expect(service.probe(server.urlFor('evil.m3u8'))).rejects.toThrow(
        /not on whitelist|Invalid data|Invalid argument/i,
      );
    }, 60000);
  });

  describe('extractThumbnail', () => {
    it('returns a JPEG frame from inside the clip', async () => {
      const thumbnail = await service.extractThumbnail(
        server.urlFor('clip.mp4'),
        1,
      );

      expect(thumbnail.length).toBeGreaterThan(0);
      expect(thumbnail.subarray(0, 3)).toEqual(JPEG_MAGIC);
    }, 60000);

    it('rejects when the input cannot be decoded', async () => {
      await expect(
        service.extractThumbnail(server.urlFor('notes.txt'), 0),
      ).rejects.toThrow();
    }, 60000);

    it('refuses to dereference a file:// reference embedded in the source', async () => {
      await expect(
        service.extractThumbnail(server.urlFor('evil.m3u8'), 0),
      ).rejects.toThrow();
    }, 60000);
  });
});
