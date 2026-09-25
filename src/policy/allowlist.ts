import { z } from 'zod';
import type { Action, UINode } from '../surface/types.js';

/**
 * Safety & policy layer.
 *
 *   1. CLASSIFY (compile time): propose an `effect` for each recorded step,
 *      so a human can review it with the artifact.
 *   2. ENFORCE (run time): allow or refuse an action based on the artifact's
 *      declared effect and the active policy. Never re-classifies.
 *
 * Keeping these separate means replay never has to guess from a label whether
 * a button is destructive.
 */

/** How reversible an action is. Used by the safety gate and by re-entry after a takeover. */
export const Effect = z.enum(['read', 'reversible', 'irreversible']);
export type Effect = z.infer<typeof Effect>;

export const PolicyConfig = z.object({
  /** Exact origins the agent may operate against. No wildcards. */
  allowedOrigins: z.array(z.string().url()),
  /** Path prefixes permitted within those origins. */
  allowedPathPrefixes: z.array(z.string()).default(['/']),
  allowedActions: z.array(z.enum(['click', 'type', 'select', 'press', 'navigate', 'read'])),
  /** Control labels that mark an action as irreversible when CLASSIFYING. */
  irreversiblePatterns: z.array(z.string()).default([
    'submit', 'confirm', 'post', 'transfer', 'delete', 'remove', 'approve',
    'authorize', 'close account', 'disburse', 'issue', 'send', 'pay',
    // Creation is irreversible too (e.g. opening an account).
    'open new', 'open account', 'create', 'register', 'enroll', 'apply',
  ]),
  /** What ENFORCEMENT does when a step declares itself irreversible. */
  onIrreversible: z.enum(['block', 'require_approval', 'flag']).default('require_approval'),
  /** Field labels whose values must never be logged or persisted. */
  sensitiveFieldPatterns: z.array(z.string()).default([
    'password', 'passcode', 'pin', 'ssn', 'social security', 'tax id', 'tin',
    'card number', 'cvv', 'security code', 'account number', 'routing',
    'date of birth', 'dob', 'mother', 'secret',
  ]),
});
export type PolicyConfig = z.infer<typeof PolicyConfig>;

export type Decision =
  | { allow: true }
  | { allow: false; reason: string; code: 'origin' | 'path' | 'action' | 'irreversible' | 'credential' }
  | { allow: 'needs_approval'; reason: string };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** CLASSIFY — compile time only. */
export function classifyEffect(policy: PolicyConfig, action: Action, node?: UINode): Effect {
  if (action.kind === 'read') return 'read';
  if (action.kind === 'navigate') return 'reversible';
  // Typing is reversible on its own; it is the submit that commits.
  if (action.kind === 'type' || action.kind === 'select' || action.kind === 'press') return 'reversible';

  const label = norm([node?.name, node?.anchorText, node?.value].filter(Boolean).join(' '));
  if (!label) return 'reversible';
  return policy.irreversiblePatterns.some((p) => label.includes(norm(p)))
    ? 'irreversible'
    : 'reversible';
}

export function checkNavigation(policy: PolicyConfig, url: string): Decision {
  let u: URL;
  try { u = new URL(url); } catch { return { allow: false, reason: `unparseable url: ${url}`, code: 'origin' }; }

  if (!policy.allowedOrigins.includes(u.origin)) {
    return { allow: false, code: 'origin', reason: `origin ${u.origin} is not in the allowlist` };
  }
  if (!policy.allowedPathPrefixes.some((p) => u.pathname.startsWith(p))) {
    return { allow: false, code: 'path', reason: `path ${u.pathname} is outside the permitted prefixes` };
  }
  return { allow: true };
}

/**
 * Is the page we are about to act on inside the allowlist? The entry URL is
 * checked before navigating, but a click can land on another site; this is
 * checked before every action. Only the top-level document is checked, so
 * third-party iframes on real sites do not block a run.
 */
export function checkLocation(policy: PolicyConfig, location: string): Decision {
  if (!/^https?:/.test(location)) return { allow: true };   // about:blank between loads
  const d = checkNavigation(policy, location);
  return d.allow === true ? d
    : { ...d, reason: `the current page (${location}) is outside the allowlist: ${(d as { reason: string }).reason}` } as Decision;
}

/** Input types that hold a secret regardless of how the field is labelled. */
const SECRET_INPUT_TYPES = new Set(['password']);

/**
 * May automation type into this control? Credential fields are refused, not
 * just redacted, so the value is never entered by automation and never
 * captured in a trace or artifact. The run escalates to a human instead.
 */
export function checkCredentialField(
  policy: PolicyConfig,
  action: Action,
  targetLabel: string | undefined,
  inputType?: string,
): Decision {
  if (action.kind !== 'type' && action.kind !== 'select') return { allow: true };

  // Check the input type first: labels can be missing (ParaBank's login
  // inputs have no accessible name), the type cannot.
  if (inputType && SECRET_INPUT_TYPES.has(inputType.toLowerCase())) {
    return {
      allow: false,
      code: 'credential',
      reason:
        `this is a password field (input type "${inputType}")${targetLabel ? ` near "${targetLabel}"` : ', with no label'}. ` +
        `Automation does not enter credentials — a human must. Escalate, or record the step as operator-supplied.`,
    };
  }

  if (!isSensitiveField(policy, targetLabel)) return { allow: true };
  return {
    allow: false,
    code: 'credential',
    reason:
      `"${targetLabel}" looks like a credential or regulated field. Automation does not enter these — ` +
      `a human must. Escalate, or record the step as operator-supplied.`,
  };
}

/**
 * ENFORCE, at run time. `declaredEffect` comes from the reviewed artifact and
 * is not re-derived here.
 */
export function checkAction(policy: PolicyConfig, action: Action, declaredEffect: Effect): Decision {
  if (!policy.allowedActions.includes(action.kind)) {
    return { allow: false, code: 'action', reason: `action "${action.kind}" is not permitted by policy` };
  }
  if (action.kind === 'navigate' && action.url) {
    const nav = checkNavigation(policy, action.url);
    if (nav.allow !== true) return nav;
  }
  if (declaredEffect === 'irreversible') {
    switch (policy.onIrreversible) {
      case 'block':
        return { allow: false, code: 'irreversible', reason: 'policy blocks irreversible actions' };
      case 'require_approval':
        // Routes to human escalation.
        return { allow: 'needs_approval', reason: 'irreversible action requires operator approval' };
      case 'flag':
        return { allow: true };
    }
  }
  return { allow: true };
}

// --- Redaction ------------------------------------------------------------
// Applied when a value is logged, not as a later cleanup pass.

const VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED:SSN]'],
  [/\b(?:\d[ -]*?){13,19}\b/g, '[REDACTED:PAN]'],
  [/\b\d{9,17}\b/g, '[REDACTED:ACCT]'],
  [/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED:EMAIL]'],
];

export function isSensitiveField(policy: PolicyConfig, label: string | undefined): boolean {
  if (!label) return false;
  const l = norm(label);
  return policy.sensitiveFieldPatterns.some((p) => l.includes(norm(p)));
}

/** Redact a value about to be logged, given the label of the field it came from. */
export function redactValue(policy: PolicyConfig, label: string | undefined, value: string): string {
  if (isSensitiveField(policy, label)) return '[REDACTED]';
  return redactText(value);
}

/** Redact free text (page content, error messages, model rationales). */
export function redactText(text: string): string {
  let out = text;
  for (const [re, rep] of VALUE_PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Policy used when no policy file is configured: the entry origin only. */
export const defaultPolicy = (origin: string): PolicyConfig =>
  PolicyConfig.parse({
    allowedOrigins: [origin],
    allowedPathPrefixes: ['/'],
    allowedActions: ['click', 'type', 'select', 'press', 'navigate', 'read'],
    onIrreversible: 'require_approval',
  });
