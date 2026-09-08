import { VIDEO_SLUG_LENGTH } from './videos.constants';
import { generateVideoSlug } from './video-slug.util';

describe('generateVideoSlug', () => {
  it('always returns a slug of the documented length', () => {
    for (let i = 0; i < 500; i++) {
      expect(generateVideoSlug()).toHaveLength(VIDEO_SLUG_LENGTH);
    }
  });

  it('only uses URL-safe characters', () => {
    for (let i = 0; i < 500; i++) {
      expect(generateVideoSlug()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('does not collide across a large sample', () => {
    const sample = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      sample.add(generateVideoSlug());
    }

    expect(sample.size).toBe(10000);
  });
});
