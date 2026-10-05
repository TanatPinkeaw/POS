// Seam under test: whether a running server is serving the build this checkout has.
//
// The failure this exists for is the one that costs a person an afternoon: a
// process left running across a rebuild keeps serving the HTML it was started
// with, its asset references then 404 against the new `.next` directory, and the
// symptom on screen (a layout that will not change, a page with no CSS) looks
// exactly like a code bug. The verdict is pure so it is asserted here without a
// server, and the script that gathers the facts is the only part that does I/O.
import { describe, expect, it } from 'vitest';

import { assessServerDrift } from '@/lib/server-drift';

const BUILD = 'txqb6h9QzXWhf74dfy1bi';
const URL = 'http://localhost:3000';

describe('a server that is not there', () => {
  it('reports unreachable before anything else is asked', () => {
    // Nothing else in the input is knowable when the process cannot be reached,
    // so this outranks a missing build on disk: the remedy is different.
    const report = assessServerDrift({
      url: URL,
      diskBuildId: null,
      reachable: false,
      manifestStatus: null,
      brokenAssets: [],
    });

    expect(report.kind).toBe('unreachable');
    expect(report.summary).toContain(URL);
    expect(report.remedy).not.toBeNull();
  });
});

describe('a checkout with no build', () => {
  it('reports no-build before blaming the server', () => {
    const report = assessServerDrift({
      url: URL,
      diskBuildId: null,
      reachable: true,
      manifestStatus: 404,
      brokenAssets: [],
    });

    expect(report.kind).toBe('no-build');
    expect(report.remedy).toContain('npm run build');
  });
});

describe('a server older than the checkout', () => {
  it('reports stale when it cannot serve this build manifest', () => {
    // The measured signature of the real incident: /login answers 200, and the
    // manifest for the build on disk answers 404.
    const report = assessServerDrift({
      url: URL,
      diskBuildId: BUILD,
      reachable: true,
      manifestStatus: 404,
      brokenAssets: [],
    });

    expect(report.kind).toBe('stale');
    expect(report.summary).toContain(BUILD);
    expect(report.remedy).not.toBeNull();
  });

  it('treats an unreadable manifest as stale rather than as clean', () => {
    // A null status is a request that did not complete. Guessing "fine" here is
    // the one answer that hides the problem this check exists to find.
    const report = assessServerDrift({
      url: URL,
      diskBuildId: BUILD,
      reachable: true,
      manifestStatus: null,
      brokenAssets: [],
    });

    expect(report.kind).toBe('stale');
  });
});

describe('a server serving this build', () => {
  it('reports current when the manifest matches and every asset loads', () => {
    const report = assessServerDrift({
      url: URL,
      diskBuildId: BUILD,
      reachable: true,
      manifestStatus: 200,
      brokenAssets: [],
    });

    expect(report.kind).toBe('current');
    // Nothing to do, so nothing is suggested.
    expect(report.remedy).toBeNull();
  });

  it('reports broken-assets, naming them, when a page references a missing file', () => {
    // A half-rebuilt `.next` — the manifest matches and one chunk is gone. This
    // is a different remedy from a stale process, which is why it is its own kind.
    const report = assessServerDrift({
      url: URL,
      diskBuildId: BUILD,
      reachable: true,
      manifestStatus: 200,
      brokenAssets: [{ route: '/display', asset: '/_next/static/chunks/gone.css', status: 404 }],
    });

    expect(report.kind).toBe('broken-assets');
    expect(report.brokenAssets).toHaveLength(1);
    expect(report.brokenAssets[0]?.asset).toBe('/_next/static/chunks/gone.css');
    expect(report.summary).toContain('/display');
  });
});
