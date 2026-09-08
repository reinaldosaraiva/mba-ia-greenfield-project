export interface ResolvedRange {
  start: number;
  end: number;
}

export type RangeRequest =
  | { kind: 'full' }
  | { kind: 'partial'; range: ResolvedRange }
  | { kind: 'unsatisfiable' };

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

// RFC 9110 §14.2: a recipient MAY ignore a Range header it cannot parse and
// answer with the whole representation, but a syntactically valid range that
// falls outside the representation must be rejected with 416.
export function parseRangeHeader(
  header: string | undefined,
  totalSize: number,
): RangeRequest {
  if (!header) {
    return { kind: 'full' };
  }

  const match = SINGLE_RANGE.exec(header.trim());
  if (!match) {
    return { kind: 'full' };
  }

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') {
    return { kind: 'full' };
  }

  if (totalSize === 0) {
    return { kind: 'unsatisfiable' };
  }

  const lastByte = totalSize - 1;

  // Suffix form `bytes=-N`: the final N bytes.
  if (rawStart === '') {
    const suffixLength = Number(rawEnd);
    if (suffixLength === 0) {
      return { kind: 'unsatisfiable' };
    }
    const start = Math.max(totalSize - suffixLength, 0);
    return { kind: 'partial', range: { start, end: lastByte } };
  }

  const start = Number(rawStart);
  if (start > lastByte) {
    return { kind: 'unsatisfiable' };
  }

  const end = rawEnd === '' ? lastByte : Math.min(Number(rawEnd), lastByte);
  if (end < start) {
    return { kind: 'unsatisfiable' };
  }

  return { kind: 'partial', range: { start, end } };
}
