import { thumbnailPosition } from './thumbnail-position.util';

describe('thumbnailPosition', () => {
  it('takes the configured fraction of a long clip', () => {
    expect(thumbnailPosition(600, 0.1)).toBe(60);
  });

  it('pushes past the first second on short clips to avoid the black lead-in', () => {
    expect(thumbnailPosition(5, 0.1)).toBe(1);
  });

  it('never lands past the end of the clip', () => {
    expect(thumbnailPosition(1.05, 0.1)).toBeCloseTo(0.95, 5);
  });

  it('stays inside a sub-second clip', () => {
    expect(thumbnailPosition(0.5, 0.1)).toBeCloseTo(0.05, 5);
  });

  it('returns zero for a duration it cannot use', () => {
    expect(thumbnailPosition(0, 0.1)).toBe(0);
    expect(thumbnailPosition(Number.NaN, 0.1)).toBe(0);
  });
});
