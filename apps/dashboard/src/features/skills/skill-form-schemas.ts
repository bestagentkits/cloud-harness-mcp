import { z } from 'zod';
import { CREATE_INSTRUCTIONS_MAX, DESCRIPTION_MAX, DISPLAY_NAME_MAX, IMPORT_SOURCE_KINDS, instructionsProblem, parseTags, REVISION_INSTRUCTIONS_MAX, SLUG_PATTERN } from './skill-model';
import { TAG_MAX } from './skill-search';

/**
 * The Skills forms' schemas. Only the form components import this module, and they load on
 * first use, so zod stays out of the page until a form opens.
 */

function instructions(max: number) {
  return z.string()
    .max(max, `Instructions can be at most ${max.toLocaleString()} characters.`)
    .superRefine((value, context) => {
      const problem = instructionsProblem(value);
      if (problem) context.addIssue({ code: 'custom', message: problem });
    });
}

export const createSkillSchema = z.object({
  slug: z.string().trim().regex(SLUG_PATTERN, 'A slug may contain letters, digits, dot, dash, and underscore (up to 120).'),
  displayName: z.string().trim().min(1, 'Enter a display name.').max(DISPLAY_NAME_MAX, `A display name can be at most ${DISPLAY_NAME_MAX} characters.`),
  instructions: instructions(CREATE_INSTRUCTIONS_MAX)
});
export type CreateSkillValues = z.infer<typeof createSkillSchema>;

export const revisionSchema = z.object({ instructions: instructions(REVISION_INSTRUCTIONS_MAX) });
export type RevisionValues = z.infer<typeof revisionSchema>;

export const skillDetailsSchema = z.object({
  displayName: z.string().trim().min(1, 'Enter a display name.').max(DISPLAY_NAME_MAX, `A display name can be at most ${DISPLAY_NAME_MAX} characters.`),
  description: z.string().max(DESCRIPTION_MAX, `A description can be at most ${DESCRIPTION_MAX.toLocaleString()} characters.`),
  tags: z.string().refine((value) => parseTags(value).length <= 16, 'At most 16 tags.')
    .refine((value) => parseTags(value).every((tag) => tag.length <= TAG_MAX), `Each tag can be at most ${TAG_MAX} characters.`)
});
export type SkillDetailsValues = z.infer<typeof skillDetailsSchema>;

/** The classic `buildSkillImportRequest` rules, as a form schema. */
export const importSchema = z.object({
  sourceKind: z.enum(IMPORT_SOURCE_KINDS),
  sourceRef: z.string().trim().min(1, 'Enter the skill source to import.').max(300, 'A source can be at most 300 characters.'),
  ref: z.string().trim().refine((value) => value === '' || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value), 'A ref has to be a full 40 or 64 character hexadecimal commit id.')
}).superRefine((value, context) => {
  if (value.sourceKind !== 'skillx' && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value.sourceRef)) {
    context.addIssue({ code: 'custom', path: ['sourceRef'], message: 'Enter the source as owner/repository.' });
  }
});
export type ImportValues = z.infer<typeof importSchema>;

export const skillSetSchema = z.object({
  name: z.string().trim().min(1, 'A skill set needs a name.').max(DISPLAY_NAME_MAX, `A name can be at most ${DISPLAY_NAME_MAX} characters.`),
  description: z.string().max(DESCRIPTION_MAX, `A description can be at most ${DESCRIPTION_MAX.toLocaleString()} characters.`)
});
export type SkillSetValues = z.infer<typeof skillSetSchema>;
