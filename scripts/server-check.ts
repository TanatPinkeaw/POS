/**
 * `npm run server:check` — is the server I am looking at the code I just wrote?
 *
 * The I/O half of `src/lib/server-drift.ts`, which holds the decision and the
 * reasoning. This file reads `.next/BUILD_ID`, asks the running process for that
 * build's manifest, and sweeps the `/_next/static/...` files each page references
 * — the three facts the verdict needs.
 *
 * Read-only by construction: no build, no database, no session, nothing written.
 * It probes a process somebody else started, which is the one thing no other gate
 * in this repo can do — `route:audit` starts its own server and so can never see
 * a stale one, and `smoke` drives the API, which a stale build answers perfectly
 * well.
 *
 * Usage:  npm run server:check                  (defaults to localhost:${PORT|3000})
 *         npm run server:check -- --url http://localhost:3104
 *         npm run server:check -- --verbose       (list every asset probed)
 */
import { existsSync, readFileSync } from 'node:fs';

import { assessServerDrift, type BrokenAsset } from '../src/lib/server-drift';

/**
 * Pages to sweep, one per area. `/pos` and `/shop` redirect without a session,
 * which is fine and deliberate: the redirect's HTML is served by the same
 * process and references the same shared chunks, so it answers the question.
 */
const ROUTES = ['/login', '/display', '/pos', '/shop'] as const;

/** A hung process must not hang the tool. */
const TIMEOUT_MS = 8_000;

/** Enough to catch a stale build on a page of any size; a report, not a download. */
const MAX_ASSETS_PER_ROUTE = 40;

function baseUrl(argv: readonly string[]): string {
  const inline = argv.find((arg) => arg.startsWith('--url='));
  if (inline) {
    return inline.slice('--url='.length);
  }
  const at = argv.indexOf('--url');
  const next = at === -1 ? undefined : argv[at + 1];
  if (next) {
    return next;
  }
  if (process.env.SERVER_CHECK_URL) {
    return process.env.SERVER_CHECK_URL;
  }
  // The same shape `smoke-test.ts` uses, and the numeric guard is the same one,
  // for the same reason: `PORT="0"` is truthy and would target the wrong port.
  const port = Number(process.env.PORT) || 3000;
  return `http://localhost:${port}`;
}

function readDiskBuildId(): string | null {
  try {
    return readFileSync('.next/BUILD_ID', 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** A fetch that reports failure as a value, because every failure here is a fact. */
async function probe(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.status;
  } catch {
    return null;
  }
}

/**
 * The `/_next/static/...` files a page's HTML references.
 *
 * The raw bytes are unescaped first: Next writes part of its payload inside
 * `<script>` JSON, where a path appears as `\/_next\/static\/…`, and matching
 * before that flattening finds nothing on exactly the pages that matter.
 */
function assetsIn(html: string): string[] {
  const flattened = html.replace(/\\/g, '');
  const found = flattened.match(/\/_next\/static\/[^"'\s<>\\)]+\.(?:js|css)/g) ?? [];
  return [...new Set(found)].slice(0, MAX_ASSETS_PER_ROUTE);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const verbose = argv.includes('--verbose');
  const url = baseUrl(argv);
  const diskBuildId = readDiskBuildId();

  if (!existsSync('.next')) {
    console.log('server check: no .next directory in this checkout');
  }

  const reachable = (await probe(`${url}/login`)) !== null;
  const manifestStatus = reachable && diskBuildId
    ? await probe(`${url}/_next/static/${diskBuildId}/_buildManifest.js`)
    : null;

  /* Only worth walking when something answered and there is a build to defend. */
  const brokenAssets: BrokenAsset[] = [];
  if (reachable) {
    const seen = new Map<string, number>();
    for (const route of ROUTES) {
      let html = '';
      try {
        const response = await fetch(`${url}${route}`, {
          redirect: 'follow',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        html = await response.text();
      } catch {
        // An unreachable route is not a drift finding; the manifest above is the
        // signal for "this process is not my build", and it already answered.
        continue;
      }

      for (const asset of assetsIn(html)) {
        if (!seen.has(asset)) {
          seen.set(asset, await probe(`${url}${asset}`) ?? 0);
        }
        const status = seen.get(asset)!;
        if (status !== 200) {
          brokenAssets.push({ route, asset, status });
        }
        if (verbose) {
          console.log(`  probed ${status} ${asset}  (from ${route})`);
        }
      }
    }
  }

  const report = assessServerDrift({ url, diskBuildId, reachable, manifestStatus, brokenAssets });

  console.log('');
  console.log(`server check: ${report.summary}`);
  for (const asset of report.brokenAssets) {
    console.log(`  ✗ ${asset.status} ${asset.asset}  (referenced by ${asset.route})`);
  }

  if (report.kind === 'current') {
    console.log('  every asset the pages reference is served by this process');
    console.log('');
    return;
  }

  console.error('');
  console.error(`server check: ${report.kind.toUpperCase()}`);
  console.error(`  ${report.remedy}`);
  console.error('');
  process.exit(1);
}

void main();
