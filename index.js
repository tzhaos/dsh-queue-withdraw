/**
 * Host half of the queue-withdraw bundle.
 *
 * The useful work is entirely browser-side: decorates rendered queue rows and
 * writes the withdrawn text into the composer draft. This no-op entry keeps the
 * Client module registry able to discover the browser bundle from a Loader row.
 */
export function apply() {}
