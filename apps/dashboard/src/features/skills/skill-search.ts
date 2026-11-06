/**
 * The Skills page's URL state, kept apart from the form schemas so the route's search
 * validator (part of the initial bundle) does not pull zod in.
 */

/** Opaque runner identifier (`opaqueId` in `packages/contracts/src/identifiers.ts`). */
export const SKILL_ID_PATTERN = /^sk_[A-Za-z0-9_-]{20,80}$/;

export const SKILL_TABS = ['library', 'imports', 'sets', 'registry'] as const;
export type SkillTab = (typeof SKILL_TABS)[number];

export const SKILL_PROVIDERS = ['skills-sh', 'skillx', 'custom', 'git'] as const;
export const SKILL_STATES = ['enabled', 'disabled', 'archived'] as const;
export const SKILL_SORTS = ['provider', 'state'] as const;
export const TAG_MAX = 32;
