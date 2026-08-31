import { isAbsolute, relative, resolve } from 'node:path';
import type { ContextManifestItem, Provenance } from './runner-api.js';

export function isPathContained(parent: string, candidate: string): boolean {
  try {
    if (!parent || !candidate) return false;
    const rel = relative(resolve(parent), resolve(candidate));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  } catch {
    return false;
  }
}

export type ScanPartitionSource = 'built-in' | 'owner' | 'workspace' | 'repository';

export interface ScanPartitionContext {
  /**
   * Trusted partition source assigned by the Runner control plane.
   * Items from repository scan partitions can NEVER be promoted to built-in or owner,
   * regardless of the path strings or metadata they contain.
   */
  partitionSource?: ScanPartitionSource;
  builtinSkillsRoot?: string;
  ownerSkillsRoot?: string;
  workspaceSkillsRoot?: string;
  trustedRoot?: string;
  repositoryRoot?: string;
}

export function sanitizeAndAttributeProvenance(
  rawItem: Record<string, unknown>,
  context: ScanPartitionContext = {}
): ContextManifestItem {
  const builtinRoot = context.builtinSkillsRoot || context.trustedRoot || process.env.CH_BUILTIN_SKILLS_ROOT || '/opt/cloud-harness/skills';
  const ownerRoot = context.ownerSkillsRoot || context.trustedRoot || process.env.CH_OWNER_SKILLS_ROOT || '/opt/cloud-harness/owner-skills';
  const workspaceSkillsRoot = context.workspaceSkillsRoot || process.env.CH_WORKSPACE_SKILLS_ROOT;

  const pathStr = typeof rawItem.path === 'string' ? rawItem.path : undefined;
  const kindStr = (typeof rawItem.kind === 'string' && ['instruction', 'language-manifest', 'test-command', 'skill-summary'].includes(rawItem.kind))
    ? (rawItem.kind as ContextManifestItem['kind'])
    : 'instruction';

  const hashStr = typeof rawItem.contentSha256 === 'string' && /^[0-9a-f]{64}$/i.test(rawItem.contentSha256)
    ? rawItem.contentSha256.toLowerCase()
    : '0'.repeat(64);

  let source: Provenance['source'] = 'repository';
  let trust: Provenance['trust'] = 'untrusted-executor';
  let mutableBy: Provenance['mutableBy'] = 'repository-commit';

  // Trust partition source ONLY from runner context, NEVER from untrusted rawItem
  const partitionSource = context.partitionSource || 'repository';

  if (kindStr === 'skill-summary' && pathStr) {
    if (partitionSource === 'built-in' && isPathContained(builtinRoot, pathStr)) {
      source = 'built-in';
      trust = 'trusted-control-plane';
      mutableBy = 'release';
    } else if (partitionSource === 'owner' && isPathContained(ownerRoot, pathStr)) {
      source = 'owner';
      trust = 'owner-controlled';
      mutableBy = 'owner';
    } else if (partitionSource === 'workspace' && workspaceSkillsRoot && isPathContained(workspaceSkillsRoot, pathStr)) {
      source = 'workspace';
      trust = 'untrusted-executor';
      mutableBy = 'workspace-process';
    }
  }

  return {
    id: typeof rawItem.id === 'string' ? rawItem.id : `ctx_${hashStr.slice(0, 12)}`,
    kind: kindStr,
    format: typeof rawItem.format === 'string' ? rawItem.format : 'plain',
    clients: Array.isArray(rawItem.clients) ? (rawItem.clients as any) : ['all'],
    path: pathStr,
    appliesTo: typeof rawItem.appliesTo === 'string' ? rawItem.appliesTo : undefined,
    activeForClient: Boolean(rawItem.activeForClient ?? true),
    contentSha256: hashStr,
    byteCount: typeof rawItem.byteCount === 'number' ? rawItem.byteCount : 0,
    excerpt: typeof rawItem.excerpt === 'string' ? rawItem.excerpt.slice(0, 8192) : undefined,
    references: Array.isArray(rawItem.references) ? (rawItem.references as string[]) : undefined,
    provenance: {
      source,
      trust,
      mutableBy,
      path: pathStr,
      contentSha256: hashStr,
      discoveredAt: new Date().toISOString()
    }
  };
}
