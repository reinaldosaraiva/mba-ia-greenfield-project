import type { Video } from './entities/video.entity';
import {
  contentDispositionAttachment,
  downloadFilename,
} from './download-filename.util';

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    title: 'My holiday clip',
    slug: 'Kx7mQ2rTb9A',
    source_key: 'videos/abc/source.mov',
    ...overrides,
  } as Video;
}

describe('downloadFilename', () => {
  it('names the file after the title and the stored extension', () => {
    expect(downloadFilename(makeVideo())).toBe('My holiday clip.mov');
  });

  it('strips characters that would break the quoted header value', () => {
    expect(downloadFilename(makeVideo({ title: 'a"b\\c/d\ne' }))).toBe(
      'abcde.mov',
    );
  });

  it('drops characters Node refuses to write in a header', () => {
    expect(downloadFilename(makeVideo({ title: 'Férias 2026 🎬' }))).toBe(
      'Frias 2026.mov',
    );
  });

  it('falls back to the slug when the title has nothing usable left', () => {
    expect(downloadFilename(makeVideo({ title: '///' }))).toBe(
      'Kx7mQ2rTb9A.mov',
    );
  });

  it('falls back to mp4 when the stored key has no usable extension', () => {
    expect(
      downloadFilename(makeVideo({ source_key: 'videos/abc/source' })),
    ).toBe('My holiday clip.mp4');
  });

  it('caps a very long title', () => {
    expect(downloadFilename(makeVideo({ title: 'x'.repeat(300) }))).toBe(
      `${'x'.repeat(100)}.mov`,
    );
  });
});

describe('contentDispositionAttachment', () => {
  it('emits both the ASCII fallback and the UTF-8 form', () => {
    expect(contentDispositionAttachment(makeVideo())).toBe(
      `attachment; filename="My holiday clip.mov"; filename*=UTF-8''My%20holiday%20clip.mov`,
    );
  });

  it('keeps the accented name in the UTF-8 form only', () => {
    const header = contentDispositionAttachment(makeVideo({ title: 'Férias' }));

    expect(header).toContain('filename="Frias.mov"');
    expect(header).toContain(
      `filename*=UTF-8''${encodeURIComponent('Férias.mov')}`,
    );
  });

  it('produces a header Node accepts', () => {
    const header = contentDispositionAttachment(
      makeVideo({ title: 'Férias 2026 🎬\r\nX-Injected: 1' }),
    );

    expect(header).not.toMatch(/[\r\n]/);
    expect(() => Buffer.from(header, 'latin1')).not.toThrow();
  });
});
