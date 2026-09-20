/**
 * Secret redaction for anything that leaves the main process.
 *
 * Run logs, error messages and audit records all flow to two places a secret
 * must never reach: the renderer (visible on screen, copyable) and the on-disk
 * audit JSONL (durable). Neither is a trusted sink, so both are passed through
 * `redactSecrets` first.
 *
 * Deliberately pattern-based rather than value-based: we cannot enumerate every
 * credential the user has ever configured, but every provider we talk to issues
 * keys with a recognisable prefix, and every HTTP client writes `Bearer <token>`.
 */

/** Prefixes issued by the providers this platform talks to. */
const KEY_PREFIXES = [
  "sk-", // OpenAI-shaped / SenseNova
  "nvapi-", // NVIDIA
  "rc-", // AMD
  "ghp_",
  "gho_",
  "github_pat_",
  "glpat-", // GitLab
  "xoxb-", // Slack
  "AIza", // Google API key
];

/**
 * A key body: base62-ish plus the punctuation JWT/base64 keys use. Bounded at
 * 12 chars minimum so ordinary prose is not mangled, at 200 so a runaway match
 * cannot swallow a whole log line.
 */
const KEY_BODY = "[A-Za-z0-9_\\-.~+/=]{12,200}";

/** Escapes a literal string for safe embedding in a RegExp. */
function escapeRe(literal: string): string {
  return literal.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
}

function prefixPattern(prefix: string): RegExp {
  // Keep the prefix visible in the placeholder: it tells the operator *which*
  // provider leaked without revealing the secret itself.
  return new RegExp(`\\b${escapeRe(prefix)}${KEY_BODY}`, "g");
}

/** `Authorization: Bearer …` / `Basic …`. */
const AUTH_HEADER = /\b(bearer|basic)(\s+)[A-Za-z0-9_\-./+=]{12,400}/gi;
/** `"apiKey":"…"` / `x-api-key: …` / `access_token=…`. */
const NAMED_SECRET =
  /((?:api[-_]?key|x-api-key|apikey|access[-_]?token|refresh[-_]?token|secret[-_]?key|client[-_]?secret|password|authorization)["'\s:=]{1,6}["']?)([A-Za-z0-9_\-./+=]{12,400})/gi;
/** A bare JWT (three base64url segments) is almost always a token. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

/** AWS-style access key ids (fixed 4-char prefix + 16 uppercase alnum). */
const AWS_KEY = /\b(AKIA|ASIA)[0-9A-Z]{12,20}\b/g;

/**
 * Returns `text` with anything that looks like a credential replaced by a
 * stable placeholder. Idempotent: redacting an already-redacted string is a
 * no-op, so it is safe to apply at more than one layer.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  out = out.replace(AUTH_HEADER, (_m, scheme: string, ws: string) => `${scheme}${ws}[REDACTED]`);
  out = out.replace(NAMED_SECRET, (_m, label: string) => `${label}[REDACTED]`);
  out = out.replace(AWS_KEY, (m) => `${m.slice(0, 4)}[REDACTED]`);
  for (const prefix of KEY_PREFIXES) {
    out = out.replace(prefixPattern(prefix), () => `${prefix}[REDACTED]`);
  }
  out = out.replace(JWT, "[REDACTED_JWT]");
  return out;
}

/** True when `text` appears to still contain a credential (assert helper). */
export function containsLikelySecret(text: string): boolean {
  return redactSecrets(text) !== text;
}
