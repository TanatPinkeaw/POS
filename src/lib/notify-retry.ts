/**
 * How often to try again, and when to stop trying.
 *
 * Pure, and separate from the outbox that uses it, for the usual reason: the
 * schedule is a *policy* and the outbox is a table. A policy decided inside a
 * worker loop can only be tested by making deliveries fail on purpose.
 *
 * The shape is a short doubling with a ceiling. The first retry is a minute away
 * because the first failure is nearly always a blip — a gateway's 502, a phone on
 * a train — and the cap exists because the alternative is a shop that discovers a
 * wrong URL by watching its own log file.
 */

/** The delays, in seconds, by attempt number. Index 0 is the first retry. */
const DELAYS_SECONDS = [60, 5 * 60, 15 * 60, 60 * 60, 6 * 60 * 60];

/**
 * How many times a single message may be attempted before it is abandoned.
 *
 * Six attempts over roughly eight hours: long enough to ride out a gateway's bad
 * morning, short enough that a misconfigured shop sees the failure on the same
 * working day. Abandoned rows stay in the table with their last error, which is
 * what makes the failure visible instead of invisible.
 */
export const MAX_ATTEMPTS = DELAYS_SECONDS.length + 1;

/** The wait before the attempt after `attempts` failures, in seconds. */
export function retryDelaySeconds(attempts: number): number {
  const index = Math.max(1, Math.min(attempts, DELAYS_SECONDS.length)) - 1;
  return DELAYS_SECONDS[index] as number;
}

/** When the next attempt is due, counted from the moment this one failed. */
export function nextAttemptAt(input: { attempts: number; now: Date }): Date {
  return new Date(input.now.getTime() + retryDelaySeconds(input.attempts) * 1000);
}

/** Whether this message has run out of attempts and should be left alone. */
export function isAbandoned(attempts: number): boolean {
  return attempts >= MAX_ATTEMPTS;
}
