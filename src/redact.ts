const MASK = "[REDACTED]";

const PATTERNS: RegExp[] = [
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk[-_][A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\b(password|passwd|secret|token|api[_-]?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
  /\b[0-9a-fA-F]{32,}\b/g,
  /[A-Za-z0-9+/_-]{40,}={0,2}/g,
];

/** Replaces common credential shapes with `[REDACTED]`. Applied before anything is stored, sent or drawn. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, (match, ...groups: unknown[]) => {
      if (/^(Bearer|Basic)\s/i.test(match)) return `${String(groups[0])} ${MASK}`;
      if (typeof groups[1] === "string" && /[=:]/.test(groups[1])) return `${String(groups[0])}${groups[1]}${MASK}`;
      return MASK;
    });
  }
  return out;
}
