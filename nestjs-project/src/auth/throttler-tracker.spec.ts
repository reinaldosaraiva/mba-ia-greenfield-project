import { throttlerTracker } from './throttler-tracker';

describe('throttlerTracker', () => {
  it('keys an authenticated request by the user id', () => {
    const req = {
      ip: '10.0.0.1',
      user: { sub: 'a9a51e10-9d44-4fa3-94f4-c2761ce6d128', email: 'a@b.c' },
    };

    expect(throttlerTracker(req)).toBe(
      'user:a9a51e10-9d44-4fa3-94f4-c2761ce6d128',
    );
  });

  it('keys an anonymous request by the client ip', () => {
    expect(throttlerTracker({ ip: '10.0.0.1' })).toBe('ip:10.0.0.1');
  });

  it('falls back to the ip when the attached user carries no id', () => {
    expect(throttlerTracker({ ip: '10.0.0.1', user: { sub: '' } })).toBe(
      'ip:10.0.0.1',
    );
    expect(throttlerTracker({ ip: '10.0.0.1', user: {} })).toBe('ip:10.0.0.1');
  });

  it('gives two users behind the same ip distinct keys', () => {
    const first = throttlerTracker({ ip: '10.0.0.1', user: { sub: 'u1' } });
    const second = throttlerTracker({ ip: '10.0.0.1', user: { sub: 'u2' } });

    expect(first).not.toBe(second);
  });
});
