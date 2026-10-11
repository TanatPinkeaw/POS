// Seam under test: the address other parties are handed (ADR 0030).
//
// Pure, because the whole failure was a derivation: behind the shop's reverse
// proxy the server sees `localhost:3000`, and a callback URL built from the
// request's own origin registered itself as `localhost` at LINE — the customer
// was never sent home at all. What is pinned here is the rule that the public
// address is configuration and wins whenever it exists, with the request origin
// as the direct-deployment fallback and trailing slashes as harmless noise.
import { describe, expect, it } from 'vitest';

import { publicBaseUrlForHeaders, publicBaseUrlOr, readPublicBaseUrl } from '@/lib/public-url';

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

describe('the same address, for a page with headers instead of a request', () => {
  // The sign-in page mints LINE's address into its button (ADR 0030 §1, amended), and a
  // server component has no `request.url` — so the rule has to be the same one, read from
  // what the request carried, or the page would hand LINE a `redirect_uri` the callback's
  // own token exchange does not agree with.
  const request = (init: Record<string, string>): Headers => new Headers(init);

  it('still prefers configuration, which is what a proxy deployment needs', () => {
    expect(
      publicBaseUrlForHeaders(request({ host: 'localhost:3000' }), {
        PUBLIC_BASE_URL: 'https://pos.example.com',
      }),
    ).toBe('https://pos.example.com');
  });

  it('falls back to the host the browser asked for', () => {
    expect(publicBaseUrlForHeaders(request({ host: '192.168.1.20:3000' }), {})).toBe(
      'http://192.168.1.20:3000',
    );
  });

  it('believes the forwarded host and scheme when a proxy added them', () => {
    expect(
      publicBaseUrlForHeaders(
        request({ host: 'localhost:3000', 'x-forwarded-host': 'pos.example.com', 'x-forwarded-proto': 'https' }),
        {},
      ),
    ).toBe('https://pos.example.com');
  });

  it('takes the client of a chain, not the hop that appended to it', () => {
    // A proxy that adds itself leaves `https, http` here; reading the whole header would
    // build `https, http://host`, which is not an address at all.
    expect(
      publicBaseUrlForHeaders(
        request({
          'x-forwarded-host': 'pos.example.com, inner.local',
          'x-forwarded-proto': 'https, http',
        }),
        {},
      ),
    ).toBe('https://pos.example.com');
  });

  it('is nothing when the request names no host at all', () => {
    expect(publicBaseUrlForHeaders(request({}), {})).toBeNull();
  });
});
