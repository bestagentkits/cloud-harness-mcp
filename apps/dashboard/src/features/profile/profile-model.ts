import { z } from 'zod';

/**
 * The display-name rule the BFF enforces on `PUT /preferences`
 * (`DISPLAY_NAME_PATTERN` in apps/api/src/dashboard-router.ts): letters and numbers in any
 * script, then the punctuation operators use in names, up to 64 characters. An empty value
 * clears the preference so the verified sign-on name shows again.
 */
export const DISPLAY_NAME_MAX = 64;
const DISPLAY_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,63}$/u;
export const DISPLAY_NAME_RULE = 'Display names may use letters, numbers, spaces, and . _ - \' only (up to 64 characters), starting with a letter or number.';

export const displayNameSchema = z.object({
  displayName: z.string().trim().max(DISPLAY_NAME_MAX, DISPLAY_NAME_RULE).refine((value) => value === '' || DISPLAY_NAME_PATTERN.test(value), DISPLAY_NAME_RULE)
});
export type DisplayNameValues = z.input<typeof displayNameSchema>;

export type ProfileView = {
  identity: { name: string | undefined; email: string | undefined; subject: string | undefined; issuer: string | undefined };
  displayName: string;
  scopes: string[];
  sessionExpiresAt: string | undefined;
};

const text = (value: unknown, max = 512): string | undefined => (typeof value === 'string' && value ? value.slice(0, max) : undefined);

/** The known fields of `GET /profile`; anything else in the answer is ignored. */
export function readProfile(raw: unknown): ProfileView {
  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const identity = data.identity && typeof data.identity === 'object' ? (data.identity as Record<string, unknown>) : {};
  const preferences = data.preferences && typeof data.preferences === 'object' ? (data.preferences as Record<string, unknown>) : {};
  return {
    identity: { name: text(identity.name), email: text(identity.email), subject: text(identity.subject), issuer: text(identity.issuer) },
    displayName: text(preferences.displayName, DISPLAY_NAME_MAX) ?? '',
    scopes: Array.isArray(data.scopes) ? data.scopes.filter((scope): scope is string => typeof scope === 'string' && scope.length > 0).slice(0, 100) : [],
    sessionExpiresAt: text(data.sessionExpiresAt, 64)
  };
}
