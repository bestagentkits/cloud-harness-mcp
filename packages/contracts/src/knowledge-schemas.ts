import { z } from 'zod';
import { ProvenanceSchema } from './runner-api.js';

export const KnowledgeItemIdSchema = z.string().regex(/^kn_[A-Za-z0-9_-]{10,80}$/, 'invalid knowledge item identifier');
export const KnowledgeLinkIdSchema = z.string().regex(/^knl_[A-Za-z0-9_-]{10,80}$/, 'invalid knowledge link identifier');
export const ProjectIdSchema = z.string().regex(/^prj_[A-Za-z0-9_-]{20,80}$/, 'invalid project identifier');

export const KnowledgeKindSchema = z.enum(['memory', 'journal']);
export type KnowledgeKind = z.infer<typeof KnowledgeKindSchema>;

export const KnowledgeScopeSchema = z.enum(['owner', 'project', 'workspace']);
export type KnowledgeScope = z.infer<typeof KnowledgeScopeSchema>;

export const JournalTypeSchema = z.enum(['engineering-log', 'decision-record', 'session-reflection']);
export type JournalType = z.infer<typeof JournalTypeSchema>;

export const KnowledgeRelationSchema = z.enum(['relates-to', 'references', 'supports', 'contradicts', 'supersedes']);
export type KnowledgeRelation = z.infer<typeof KnowledgeRelationSchema>;

export const KnowledgeLinkOriginSchema = z.enum(['manual', 'wikilink']);
export type KnowledgeLinkOrigin = z.infer<typeof KnowledgeLinkOriginSchema>;

export const KnowledgeTagSchema = z.string().trim().min(1).max(50).regex(/^[A-Za-z0-9._/-]+$/, 'invalid tag format');

export const KnowledgeItemSchema = z.object({
  id: KnowledgeItemIdSchema,
  principalId: z.string().min(1).max(100),
  kind: KnowledgeKindSchema,
  scope: KnowledgeScopeSchema,
  projectId: z.string().nullable().optional(),
  workspaceId: z.string().nullable().optional(),
  title: z.string().min(1).max(120),
  content: z.string().max(262_144),
  contentSha256: z.string().length(64),
  journalType: JournalTypeSchema.nullable().optional(),
  occurredAt: z.number().int().positive().nullable().optional(),
  generation: z.number().int().positive(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive().nullable().optional(),
  deletedAt: z.number().int().positive().nullable().optional(),
  tags: z.array(KnowledgeTagSchema).max(16).default([]),
  provenance: ProvenanceSchema.optional()
}).strict().superRefine((val, ctx) => {
  if (val.scope === 'owner' && (val.projectId || val.workspaceId)) {
    ctx.addIssue({ code: 'custom', message: 'owner-scoped item cannot have projectId or workspaceId' });
  }
  if (val.scope === 'project' && (!val.projectId || val.workspaceId)) {
    ctx.addIssue({ code: 'custom', message: 'project-scoped item must have projectId and no workspaceId' });
  }
  if (val.scope === 'workspace' && !val.workspaceId) {
    ctx.addIssue({ code: 'custom', message: 'workspace-scoped item must have workspaceId' });
  }
  if (val.kind === 'journal' && (!val.journalType || !val.occurredAt)) {
    ctx.addIssue({ code: 'custom', message: 'journal item must have journalType and occurredAt' });
  }
  if (val.kind === 'memory' && val.journalType) {
    ctx.addIssue({ code: 'custom', message: 'memory item cannot have journalType' });
  }
});
export type KnowledgeItem = z.infer<typeof KnowledgeItemSchema>;

export const KnowledgeLinkSchema = z.object({
  id: KnowledgeLinkIdSchema,
  principalId: z.string().min(1).max(100),
  sourceId: KnowledgeItemIdSchema,
  targetId: KnowledgeItemIdSchema,
  relation: KnowledgeRelationSchema,
  origin: KnowledgeLinkOriginSchema,
  createdAt: z.number().int().positive(),
  generation: z.number().int().positive()
}).strict();
export type KnowledgeLink = z.infer<typeof KnowledgeLinkSchema>;

export const KnowledgeSearchMatchModeSchema = z.enum(['hybrid', 'lexical', 'semantic', 'lexical_fallback']);
export type KnowledgeSearchMatchMode = z.infer<typeof KnowledgeSearchMatchModeSchema>;

export const KnowledgeSearchResultItemSchema = z.object({
  item: KnowledgeItemSchema,
  relevancePercent: z.number().min(0).max(100),
  matchMode: KnowledgeSearchMatchModeSchema,
  ftsRank: z.number().optional(),
  semanticRank: z.number().optional(),
  snippet: z.string().optional()
}).strict();
export type KnowledgeSearchResultItem = z.infer<typeof KnowledgeSearchResultItemSchema>;

export const KnowledgeGraphNodeSchema = z.object({
  id: KnowledgeItemIdSchema,
  kind: KnowledgeKindSchema,
  scope: KnowledgeScopeSchema,
  title: z.string(),
  journalType: JournalTypeSchema.nullable().optional(),
  tags: z.array(z.string()),
  updatedAt: z.number()
}).strict();
export type KnowledgeGraphNode = z.infer<typeof KnowledgeGraphNodeSchema>;

export const KnowledgeGraphEdgeSchema = z.object({
  id: KnowledgeLinkIdSchema,
  sourceId: KnowledgeItemIdSchema,
  targetId: KnowledgeItemIdSchema,
  relation: KnowledgeRelationSchema,
  origin: KnowledgeLinkOriginSchema
}).strict();
export type KnowledgeGraphEdge = z.infer<typeof KnowledgeGraphEdgeSchema>;

export const KnowledgeGraphResultSchema = z.object({
  nodes: z.array(KnowledgeGraphNodeSchema),
  edges: z.array(KnowledgeGraphEdgeSchema),
  truncated: z.boolean().default(false)
}).strict();
export type KnowledgeGraphResult = z.infer<typeof KnowledgeGraphResultSchema>;

export const KnowledgeConflictStateSchema = z.object({
  baseGeneration: z.number().int().nonnegative(),
  currentGeneration: z.number().int().positive(),
  currentContent: z.string(),
  yoursContent: z.string(),
  updatedAt: z.number()
}).strict();
export type KnowledgeConflictState = z.infer<typeof KnowledgeConflictStateSchema>;
