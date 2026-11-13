const MASK = "[REDACTED]";

type Rule = { re: RegExp; replace: (match: string, ...groups: string[]) => string; hash?: true };

const RULES: Rule[] = [
  // Authorization headers: keep the scheme, mask the credential.
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, replace: (_m, scheme) => `${scheme} ${MASK}` },
  // key=value / key: value for secret-looking keys: keep the key and separator.
  {
    re: /\b(password|passwd|secret|token|api[_-]?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    replace: (_m, key, sep) => `${key}${sep}${MASK}`,
  },
  { re: /\bsk[-_][A-Za-z0-9_-]{16,}/g, replace: () => MASK },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: () => MASK },
  // Long hex strings (keys, signatures). Git object names look the same; see `keepHashes`.
  { re: /\b[0-9a-fA-F]{32,}\b/g, replace: () => MASK, hash: true },
  // Long base64-like tokens: a run of 40+ characters mixing upper case, lower case and digits that does not
  // look like a path. Base64 keys may contain "/", so the whole run is judged, not each segment.
  { re: /[A-Za-z0-9+/_-]{40,}={0,2}/g, replace: (m) => (isMixed(m) && !looksLikePath(m) ? MASK : m) },
];

/**
 * Replaces common credential shapes with `[REDACTED]`. Applied before anything is stored, sent or drawn.
 * `keepHashes` leaves long hex strings (git commit and object names) alone; use it only for git references.
 */
export function redactSecrets(text: string, opts: { keepHashes?: boolean } = {}): string {
  let out = text;
  for (const rule of RULES) {
    if (rule.hash && opts.keepHashes) continue;
    out = out.replace(rule.re, (match: string, ...rest: unknown[]) => {
      const groups = rest.filter((g): g is string => typeof g === "string").slice(0, -1);
      return rule.replace(match, ...groups);
    });
  }
  return out;
}

function isMixed(run: string): boolean {
  return /[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run);
}

/** A path starts with "/", has many segments, or has a segment that is a plain lower-case word ("src", "users"). */
function looksLikePath(run: string): boolean {
  if (!run.includes("/")) return false;
  if (run.startsWith("/")) return true;
  const segments = run.split("/");
  if (segments.length > 4) return true;
  return segments.some((seg) => /^[a-z][a-z_-]{2,}$/.test(seg));
}
