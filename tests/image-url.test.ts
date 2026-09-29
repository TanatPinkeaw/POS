/**
 * The allowlist in front of every product photo (ADR 0014).
 *
 * A shop pastes these links by hand, so the interesting cases are the ones a person
 * really types: a link with a space around it, a link with no scheme, and a link from
 * a screen where the picture was inline. Each must end as `null` — the placeholder —
 * rather than as a broken image on a counter screen.
 */
import { describe, expect, it } from 'vitest';

import { renderableImageUrl } from '@/lib/image-url';

describe('the image link allowlist', () => {
  it('accepts the links a shop keeps its pictures behind', () => {
    // The reference installation's own storage: a Nextcloud preview inside the
    // same homelab, on its own host, which is what ADR 0014 is about.
    expect(
      renderableImageUrl('https://drive.example.stream/s/abc123/preview'),
    ).toBe('https://drive.example.stream/s/abc123/preview');
    expect(renderableImageUrl('http://192.168.1.9/photos/coffee.jpg')).toBe(
      'http://192.168.1.9/photos/coffee.jpg',
    );
  });

  it('accepts a path this deployment serves itself', () => {
    expect(renderableImageUrl('/products/coffee.jpg')).toBe('/products/coffee.jpg');
  });

  it('trims what a paste brings with it', () => {
    expect(renderableImageUrl('  https://drive.example.stream/x.jpg \n')).toBe(
      'https://drive.example.stream/x.jpg',
    );
  });

  it('refuses an empty value, which is every product until somebody fills one in', () => {
    expect(renderableImageUrl(null)).toBeNull();
    expect(renderableImageUrl(undefined)).toBeNull();
    expect(renderableImageUrl('')).toBeNull();
    expect(renderableImageUrl('   ')).toBeNull();
  });

  it('refuses an image inline in the column', () => {
    // Not squeamishness about data: URIs — it is the catalogue's paging. A 200 kB
    // picture per row is a query that exists to avoid sending a table to a browser.
    expect(renderableImageUrl('data:image/png;base64,iVBORw0KGgo=')).toBeNull();
  });

  it('refuses a scheme that is not a picture', () => {
    expect(renderableImageUrl('javascript:alert(1)')).toBeNull();
    expect(renderableImageUrl('file:///C:/shop/coffee.jpg')).toBeNull();
  });

  it('refuses a bare host, which a browser would resolve against the wrong page', () => {
    expect(renderableImageUrl('example.com/x.jpg')).toBeNull();
    expect(renderableImageUrl('drive.example.stream/s/x.jpg')).toBeNull();
  });

  it('refuses a protocol-relative link, whose origin cannot be read off the paste', () => {
    expect(renderableImageUrl('//drive.example.stream/x.jpg')).toBeNull();
  });
});
