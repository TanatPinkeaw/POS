/**
 * Phone numbers, as the system stores them.
 *
 * A phone number is the login identifier for every role in this app — a cashier
 * signs in with one, and so does a customer — and it is also the key the till
 * looks a customer up by. That makes one small property load-bearing: the same
 * person typing `080-000-0002` and `0800000002` must be one account, not two.
 *
 * It lives on its own rather than inside `staff.ts` because both surfaces need it
 * and neither owns it. Two copies of this regex is how the counter ends up unable
 * to find a customer whose number a manager typed with a dash in it.
 */

/**
 * Strips the punctuation Thai phone numbers are usually written with, so
 * `080-000-0002`, `080 000 0002` and `0800000002` are the same person.
 *
 * Punctuation only — deliberately not a format check. The rule for what a Thai
 * number looks like is a moving target (`+66`, ten digits, a leading zero that is
 * sometimes dropped), and a shop's own numbers are the ones that matter. The
 * column is `VARCHAR(20)` and uniqueness is enforced on whatever survives this.
 */
export function normalisePhone(phone: string): string {
  return phone.replace(/[\s()\-.]/g, '');
}
