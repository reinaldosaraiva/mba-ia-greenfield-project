import { generateVideoClip, GeneratedClip } from '../../test/video-fixture';
import { FfmpegService } from './ffmpeg.service';

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

describe('FfmpegService (integration)', () => {
  const service = new FfmpegService();
  let clip: GeneratedClip;

  beforeAll(async () => {
    clip = await generateVideoClip(3, 320, 240);
  }, 60000);

  afterAll(async () => {
    await clip.cleanup();
  });

  describe('probe', () => {
    it('reads duration, dimensions and codecs from a real clip', async () => {
      const result = await service.probe(clip.path);

      expect(result.durationSeconds).toBe(clip.durationSeconds);
      expect(result.metadata.width).toBe(clip.width);
      expect(result.metadata.height).toBe(clip.height);
      expect(result.metadata.video_codec).toBe('h264');
      expect(result.metadata.audio_codec).toBe('aac');
      expect(result.metadata.format_name).toContain('mp4');
      expect(result.metadata.bit_rate).toBeGreaterThan(0);
    }, 60000);

    it('rejects an input with no video stream', async () => {
      await expect(service.probe('/etc/hostname')).rejects.toThrow();
    }, 60000);
  });

  describe('extractThumbnail', () => {
    it('returns a JPEG frame from inside the clip', async () => {
      const thumbnail = await service.extractThumbnail(clip.path, 1);

      expect(thumbnail.length).toBeGreaterThan(0);
      expect(thumbnail.subarray(0, 3)).toEqual(JPEG_MAGIC);
    }, 60000);

    it('rejects when the input cannot be decoded', async () => {
      await expect(
        service.extractThumbnail('/etc/hostname', 0),
      ).rejects.toThrow();
    }, 60000);
  });
});
