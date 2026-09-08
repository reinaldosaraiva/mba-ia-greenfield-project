import type { Video } from './entities/video.entity';
import { downloadFilename } from './download-filename.util';

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
    const name = downloadFilename(makeVideo({ title: 'x'.repeat(300) }));

    expect(name).toBe(`${'x'.repeat(100)}.mov`);
  });
});
