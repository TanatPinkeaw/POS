/**
 * Is the server somebody is looking at the build this checkout has?
 *
 * This exists because the answer is otherwise unguessable and the symptom is
 * misleading. A process started before a rebuild keeps the build manifest it was
 * started with in memory; the HTML it serves still names the old asset files,
 * those files are gone from a freshly rebuilt `.next`, and the browser is left
 * with a page whose CSS and JS 404 — a layout that will not change no matter what
 * the source says. It reads exactly like a bug in the code, and the one thing a
 * person does not think to check is that the thing they are looking at is not
 * their code at all.
 *
 * The decision is pure and lives here; `scripts/server-check.ts` gathers the
 * facts (read the build id on disk, ask the running server for that build's
 * manifest, sweep the assets each page references) and is the only part that does
 * I/O. The split is the repo's usual one, and it is what makes the precedence
 * below — which matters more than any individual string — assertable without a
 * server. `npm run smoke` drives the API against a running process and would not
 * have caught any of this: the API of a stale build answers perfectly well.
 *
 * English, not Thai: this is a maintenance tool that prints to a terminal for
 * whoever runs the shop's box, not a refusal a customer reads at a counter.
 */

/** One `/_next/static/...` file a served page referenced that did not come back. */
export interface BrokenAsset {
  /** The route whose HTML referenced it, so the report names where to look. */
  route: string;
  asset: string;
  status: number;
}

export interface DriftInput {
  /** The base URL that was probed, echoed into the report. */
  url: string;
  /** `.next/BUILD_ID` on disk, or null when there is no build to compare against. */
  diskBuildId: string | null;
  /** False when the process did not answer at all. */
  reachable: boolean;
  /** Status of this build's `_buildManifest.js`, or null if that request failed. */
  manifestStatus: number | null;
  brokenAssets: readonly BrokenAsset[];
}

export type DriftKind = 'unreachable' | 'no-build' | 'stale' | 'broken-assets' | 'current';

export interface DriftReport {
  kind: DriftKind;
  /** One line saying what was found. */
  summary: string;
  /** What to do about it, or null when there is nothing to do. */
  remedy: string | null;
  brokenAssets: readonly BrokenAsset[];
}

/**
 * The precedence is the design, and it runs most-fundamental first:
 *
 *   1. Nothing answered — no other fact is knowable, and the remedy is "start it".
 *   2. No build on disk — the server cannot be behind a build that does not exist.
 *   3. The manifest does not match — the process predates this build.
 *   4. The manifest matched but an asset is missing — a partial `.next`, which is a
 *      rebuild problem rather than a restart problem, so it gets its own remedy.
 *   5. Clean.
 */
export function assessServerDrift(input: DriftInput): DriftReport {
  if (!input.reachable) {
    return {
      kind: 'unreachable',
      summary: `no server answered at ${input.url}`,
      remedy: `Start it (\`npm run dev\`, or \`npm run build && npm run start\`) and run this again.`,
      brokenAssets: [],
    };
  }

  if (input.diskBuildId === null) {
    return {
      kind: 'no-build',
      summary: `there is no .next build in this checkout to compare against`,
      remedy: 'Run `npm run build` first, then start the server from that build.',
      brokenAssets: [],
    };
  }

  if (input.manifestStatus !== 200) {
    return {
      kind: 'stale',
      summary:
        `${input.url} is running a build older than this checkout — it cannot serve ` +
        `this build's manifest (${input.diskBuildId}), status ${input.manifestStatus ?? 'no response'}`,
      remedy:
        'Restart it: stop the process and run `npm run start` again. Until then the pages it ' +
        'serves reference asset files that no longer exist.',
      brokenAssets: input.brokenAssets,
    };
  }

  if (input.brokenAssets.length > 0) {
    const first = input.brokenAssets[0]!;
    return {
      kind: 'broken-assets',
      summary:
        `${input.brokenAssets.length} asset(s) a served page references are missing, ` +
        `first ${first.asset} on ${first.route} (status ${first.status})`,
      remedy: 'Run `npm run build` again and restart: the .next directory is inconsistent.',
      brokenAssets: input.brokenAssets,
    };
  }

  return {
    kind: 'current',
    summary: `${input.url} is serving this checkout's build (${input.diskBuildId})`,
    remedy: null,
    brokenAssets: [],
  };
}
