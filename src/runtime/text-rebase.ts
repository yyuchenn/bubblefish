/** A single user change in UTF-16 positions, matching DOM textarea selections. */
export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

const high = (code: number) => code >= 0xd800 && code <= 0xdbff;
const low = (code: number) => code >= 0xdc00 && code <= 0xdfff;

export function textChange(before: string, after: string): TextChange {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  if (
    from > 0 &&
    ((high(before.charCodeAt(from - 1)) && low(before.charCodeAt(from))) ||
      (high(after.charCodeAt(from - 1)) && low(after.charCodeAt(from))))
  )
    from--;
  let endBefore = before.length,
    endAfter = after.length;
  while (endBefore > from && endAfter > from && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  if (
    endBefore < before.length &&
    high(before.charCodeAt(endBefore - 1)) &&
    low(before.charCodeAt(endBefore))
  ) {
    endBefore++;
    endAfter++;
  }
  return { from, to: endBefore, insert: after.slice(from, endAfter) };
}

/** Replay a change on the acknowledged value, preserving equal-length rewrites.
 * Overlapping unequal-length replacements are ambiguous and must become drafts. */
export function rebaseTextChange(
  before: string,
  canonical: string,
  change: TextChange,
): { text: string; change: TextChange } | null {
  if (change.from < 0 || change.to < change.from || change.to > before.length) return null;
  let mapped = change;
  if (before !== canonical && before.length !== canonical.length) {
    const rewrite = textChange(before, canonical);
    const delta = rewrite.insert.length - (rewrite.to - rewrite.from);
    const map = (position: number) =>
      rewrite.from === rewrite.to
        ? position < rewrite.from
          ? position
          : position + delta
        : position <= rewrite.from
          ? position
          : position >= rewrite.to
            ? position + delta
            : null;
    const from = map(change.from),
      to = map(change.to);
    if (from === null || to === null || (change.from < rewrite.to && change.to > rewrite.from))
      return null;
    mapped = { ...change, from, to };
  }
  return {
    text: canonical.slice(0, mapped.from) + mapped.insert + canonical.slice(mapped.to),
    change: mapped,
  };
}
