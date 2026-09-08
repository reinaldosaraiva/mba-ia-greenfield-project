const MIN_POSITION_SECONDS = 1;
const TAIL_MARGIN_SECONDS = 0.1;

// A frame taken at t=0 is often a black lead-in, so the position is a fraction
// of the duration, pushed past the first second when the clip is long enough
// and always kept inside the clip.
export function thumbnailPosition(
  durationSeconds: number,
  ratio: number,
): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 0;
  }

  const target = durationSeconds * ratio;
  const floored =
    durationSeconds > MIN_POSITION_SECONDS
      ? Math.max(target, MIN_POSITION_SECONDS)
      : target;

  return Math.min(floored, Math.max(durationSeconds - TAIL_MARGIN_SECONDS, 0));
}
