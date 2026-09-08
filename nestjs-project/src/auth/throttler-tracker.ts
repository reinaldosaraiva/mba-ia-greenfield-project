import { THROTTLE_TRACKER_PREFIX } from './auth.constants';
import type { JwtPayload } from './auth.types';

export function throttlerTracker(req: Record<string, any>): string {
  const user = req.user as Partial<JwtPayload> | undefined;
  if (typeof user?.sub === 'string' && user.sub.length > 0) {
    return `${THROTTLE_TRACKER_PREFIX.USER}${user.sub}`;
  }
  return `${THROTTLE_TRACKER_PREFIX.IP}${String(req.ip)}`;
}
