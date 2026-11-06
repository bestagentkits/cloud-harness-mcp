import { z } from 'zod';
import { RESOURCE_ID_PATTERNS } from '@/app/page-registry';
import { CONTENT_MAX, JOURNAL_TYPES, KNOWLEDGE_KINDS, KNOWLEDGE_SCOPES, parseTags, TAGS_MAX, TITLE_MAX } from './knowledge-model';

/**
 * The new-entry form's schema. Only the create dialog imports this module, and it loads on
 * first use, so zod stays out of the Knowledge page until the dialog opens.
 */

const TAG = /^[A-Za-z0-9._/-]{1,50}$/;

export const createKnowledgeSchema = z.object({
  kind: z.enum(KNOWLEDGE_KINDS),
  scope: z.enum(KNOWLEDGE_SCOPES),
  projectId: z.string(),
  workspaceId: z.string(),
  journalType: z.enum(JOURNAL_TYPES),
  title: z.string().trim().min(1, 'Enter a title.').max(TITLE_MAX, `Use at most ${TITLE_MAX} characters.`),
  tags: z.string().max(2_000).refine((raw) => parseTags(raw).length <= TAGS_MAX, `Use at most ${TAGS_MAX} tags.`).refine((raw) => parseTags(raw).every((tag) => TAG.test(tag)), 'Tags use letters, digits and . _ / - (50 characters at most).'),
  content: z.string().max(CONTENT_MAX, 'The content is too long.')
}).superRefine((values, context) => {
  if (values.scope === 'project' && !RESOURCE_ID_PATTERNS.projectId.test(values.projectId)) context.addIssue({ code: 'custom', path: ['projectId'], message: 'Choose a project.' });
  if (values.scope === 'workspace' && !RESOURCE_ID_PATTERNS.workspaceId.test(values.workspaceId.trim())) context.addIssue({ code: 'custom', path: ['workspaceId'], message: 'Enter a workspace ID (ws_…).' });
});
export type CreateKnowledgeValues = z.infer<typeof createKnowledgeSchema>;
