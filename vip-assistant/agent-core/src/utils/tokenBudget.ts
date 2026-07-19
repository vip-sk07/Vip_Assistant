/**
 * AGENT CORE — utils/tokenBudget.ts
 *
 * Parses inline token budget directives from user messages.
 * Direct port of the logic inferred from the blueprint's tokenBudget.ts +
 * thinking.ts files.
 *
 * Supported syntax (case-insensitive):
 *   +500k          → 500,000 tokens  (shorthand at start)
 *   ...text +500k. → 500,000 tokens  (shorthand at end)
 *   use 2m tokens  → 2,000,000 tokens (verbose anywhere)
 *   spend 1.5b tokens → 1,500,000,000 tokens
 *
 * Also supports the "ultrathink" keyword which triggers maximum reasoning budget.
 */

const SHORTHAND_START = /^\s*\+(\d+(?:\.\d+)?)\s*(k|m|b)\b/i;
const SHORTHAND_END   = /\s\+(\d+(?:\.\d+)?)\s*(k|m|b)\s*[.!?]?\s*$/i;
const VERBOSE_RE      = /\b(?:use|spend)\s+(\d+(?:\.\d+)?)\s*(k|m|b)\s*tokens?\b/i;
const VERBOSE_RE_G    = new RegExp(VERBOSE_RE.source, "gi");
const ULTRATHINK_RE   = /\bultrathink\b/i;

const MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
};

// ─────────────────────────────────────────────────────────────────────────────

function parseBudgetMatch(value: string, suffix: string): number {
  return parseFloat(value) * (MULTIPLIERS[suffix.toLowerCase()] ?? 1);
}

/**
 * Extract an explicit token budget from user message text.
 * Returns null if no budget directive is present.
 */
export function parseTokenBudget(text: string): number | null {
  // "ultrathink" gets the maximum reasoning budget
  if (ULTRATHINK_RE.test(text)) return 100_000;

  const startMatch = text.match(SHORTHAND_START);
  if (startMatch) return parseBudgetMatch(startMatch[1]!, startMatch[2]!);

  const endMatch = text.match(SHORTHAND_END);
  if (endMatch) return parseBudgetMatch(endMatch[1]!, endMatch[2]!);

  const verboseMatch = text.match(VERBOSE_RE);
  if (verboseMatch) return parseBudgetMatch(verboseMatch[1]!, verboseMatch[2]!);

  return null;
}

/**
 * Find the character positions of budget directives in text
 * (used by the UI to highlight / dim them).
 */
export function findTokenBudgetPositions(
  text: string,
): Array<{ start: number; end: number }> {
  const positions: Array<{ start: number; end: number }> = [];

  const startMatch = text.match(SHORTHAND_START);
  if (startMatch && startMatch.index !== undefined) {
    const offset = startMatch.index + startMatch[0].length - startMatch[0].trimStart().length;
    positions.push({ start: offset, end: startMatch.index + startMatch[0].length });
  }

  const endMatch = text.match(SHORTHAND_END);
  if (endMatch && endMatch.index !== undefined) {
    const endStart = endMatch.index + 1; // regex includes leading \s
    const alreadyCovered = positions.some(p => endStart >= p.start && endStart < p.end);
    if (!alreadyCovered) {
      positions.push({ start: endStart, end: endMatch.index + endMatch[0].length });
    }
  }

  for (const match of text.matchAll(VERBOSE_RE_G)) {
    positions.push({ start: match.index!, end: match.index! + match[0].length });
  }

  return positions;
}

/**
 * Build the continuation message injected when the model hits its token budget.
 * "Keep working — do not summarize."
 */
export function getBudgetContinuationMessage(
  pct: number,
  turnTokens: number,
  budget: number,
): string {
  const fmt = (n: number) => new Intl.NumberFormat("en-US").format(n);
  return (
    `Stopped at ${pct}% of token target ` +
    `(${fmt(turnTokens)} / ${fmt(budget)}). ` +
    `Keep working \u2014 do not summarize.`
  );
}

/**
 * Detect whether the user message contains the "ultrathink" keyword,
 * which triggers maximum extended thinking.
 */
export function hasUltrathinkKeyword(text: string): boolean {
  return ULTRATHINK_RE.test(text);
}
