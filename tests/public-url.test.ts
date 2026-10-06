// Seam under test: the address other parties are handed (ADR 0030).
//
// Pure, because the whole failure was a derivation: behind the shop's reverse
// proxy the server sees `localhost:3000`, and a callback URL built from the
// request's own origin registered itself as `localhost` at LINE — the customer
// was never sent home at all. What is pinned here is the rule that the public
// address is configuration and wins whenever it exists, with the request origin
// as the direct-deployment fallback and trailing slashes as harmless noise.
import { describe, expect, it } from 'vitest';

import { publicBaseUrlOr, readPublicBaseUrl } from '@/lib/public-url';

describe(`the deployment's public address`, () => {
  it('is configuration, read trimmed and without trailing slashes', () => {
    expect(readPublicBaseUrl({ PUBLIC_BASE_URL: 'https://pos.example.com' })).toBe(
      'https://pos.example.com',
    );
    expect(readPublicBaseUrl({ PUBLIC_BASE_URL: '  https://pos.example.com/  ' })).toBe(
      'https://pos.example.com',
    );
    expect(readPublicBaseUrl({ PUBLIC_BASE_URL: 'https://pos.example.com///' })).toBe(
      'https://pos.example.com',
    );
  });

  it('is nothing when unset or blank', () => {
    expect(readPublicBaseUrl({})).toBeNull();
    expect(readPublicBaseUrl({ PUBLIC_BASE_URL: '   ' })).toBeNull();
  });

  it('wins over the request origin whenever it exists', () => {
    // The whole bug: the request behind a proxy carries localhost. Configuration
    // must answer, or every URL we hand out names a host the browser cannot reach.
    expect(
      publicBaseUrlOr('http://localhost:3000/api/v1/auth/line/callback', {
        PUBLIC_BASE_URL: 'https://pos.example.com',
      }),
    ).toBe('https://pos.example.com');
  });

  it('falls back to the request origin on a direct deployment', () => {
    expect(publicBaseUrlOr('http://localhost:3000/path', {})).toBe('http://localhost:3000');
  });
});
