import { parseRangeHeader } from './range.util';

const TOTAL = 100;

describe('parseRangeHeader', () => {
  it('treats an absent header as a request for the whole object', () => {
    expect(parseRangeHeader(undefined, TOTAL)).toEqual({ kind: 'full' });
  });

  it('resolves an explicit window', () => {
    expect(parseRangeHeader('bytes=10-19', TOTAL)).toEqual({
      kind: 'partial',
      range: { start: 10, end: 19 },
    });
  });

  it('resolves an open-ended range to the last byte', () => {
    expect(parseRangeHeader('bytes=0-', TOTAL)).toEqual({
      kind: 'partial',
      range: { start: 0, end: 99 },
    });
  });

  it('resolves a suffix range to the final bytes', () => {
    expect(parseRangeHeader('bytes=-30', TOTAL)).toEqual({
      kind: 'partial',
      range: { start: 70, end: 99 },
    });
  });

  it('clamps a suffix longer than the object to the whole object', () => {
    expect(parseRangeHeader('bytes=-500', TOTAL)).toEqual({
      kind: 'partial',
      range: { start: 0, end: 99 },
    });
  });

  it('clamps an end beyond the last byte', () => {
    expect(parseRangeHeader('bytes=90-500', TOTAL)).toEqual({
      kind: 'partial',
      range: { start: 90, end: 99 },
    });
  });

  it('rejects a start past the end of the object', () => {
    expect(parseRangeHeader('bytes=100-200', TOTAL)).toEqual({
      kind: 'unsatisfiable',
    });
  });

  it('rejects an inverted range', () => {
    expect(parseRangeHeader('bytes=50-10', TOTAL)).toEqual({
      kind: 'unsatisfiable',
    });
  });

  it('rejects a zero-length suffix', () => {
    expect(parseRangeHeader('bytes=-0', TOTAL)).toEqual({
      kind: 'unsatisfiable',
    });
  });

  it('rejects any range against an empty object', () => {
    expect(parseRangeHeader('bytes=0-10', 0)).toEqual({
      kind: 'unsatisfiable',
    });
  });

  it('ignores a header it cannot parse and serves the whole object', () => {
    expect(parseRangeHeader('items=0-10', TOTAL)).toEqual({ kind: 'full' });
    expect(parseRangeHeader('bytes=abc', TOTAL)).toEqual({ kind: 'full' });
    expect(parseRangeHeader('bytes=0-10, 20-30', TOTAL)).toEqual({
      kind: 'full',
    });
  });
});
