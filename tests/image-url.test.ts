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

describe('a public share link is read as the picture inside it (ADR 0014)', () => {
  it('rewrites the share page to its preview endpoint', () => {
    /*
     * Measured against the reference installation's own Nextcloud, because this is a
     * fact about that server rather than about links in general: the link an operator
     * copies out of the address bar answers `200 text/html` (a 26 kB page whose
     * `<title>` is the file's name), and only `/preview` beside it answers
     * `200 image/png`. So the paste that looks most correct — the one the browser
     * shows them — is the one every tile draws a placeholder for, and the form's live
     * preview refuses it before it can be saved at all.
     */
    expect(renderableImageUrl('https://drive.example.stream/s/eXwR4xNmDgBtnps')).toBe(
      'https://drive.example.stream/s/eXwR4xNmDgBtnps/preview',
    );
    expect(renderableImageUrl('https://drive.example.stream/s/eXwR4xNmDgBtnps/')).toBe(
      'https://drive.example.stream/s/eXwR4xNmDgBtnps/preview',
    );
    // The same route spelled through the front controller, which is what a share
    // copied from a Nextcloud whose clean URLs are switched off looks like.
    expect(
      renderableImageUrl('https://drive.example.stream/index.php/s/eXwR4xNmDgBtnps'),
    ).toBe('https://drive.example.stream/index.php/s/eXwR4xNmDgBtnps/preview');
  });

  it('carries the query along, which is where a folder share names the file', () => {
    expect(renderableImageUrl('https://drive.example.stream/s/abc123?path=/a.png')).toBe(
      'https://drive.example.stream/s/abc123/preview?path=/a.png',
    );
  });

  it('leaves a link alone when it is already the picture, or already an endpoint', () => {
    // Rewriting either of these a second time is how a working link gets broken:
    // `/preview/preview` and `/download/preview` are both 404s on a real server.
    expect(renderableImageUrl('https://drive.example.stream/s/abc123/preview')).toBe(
      'https://drive.example.stream/s/abc123/preview',
    );
    expect(renderableImageUrl('https://drive.example.stream/s/abc123/download')).toBe(
      'https://drive.example.stream/s/abc123/download',
    );
  });

  it('does not touch a link that only looks like a share', () => {
    /*
     * Narrow on purpose. This function rewrites a URL somebody else will serve, so a
     * false positive breaks a link that worked: a photo host with directories named
     * `s` and `abc123` is far-fetched, but a rule loose enough to accept
     * `/s/abc123/photo.png` would append `/preview` to real pictures. Nextcloud's own
     * share tokens are alphanumeric, and only the bare share root is rewritten.
     */
    expect(renderableImageUrl('https://cdn.example.com/s/abc123/photo.png')).toBe(
      'https://cdn.example.com/s/abc123/photo.png',
    );
    expect(renderableImageUrl('https://cdn.example.com/s/abc-123')).toBe(
      'https://cdn.example.com/s/abc-123',
    );
    expect(renderableImageUrl('https://cdn.example.com/photos/coffee.jpg')).toBe(
      'https://cdn.example.com/photos/coffee.jpg',
    );
    // Root-relative links are this deployment's own files, never another host's share.
    expect(renderableImageUrl('/s/abc123')).toBe('/s/abc123');
  });
});
