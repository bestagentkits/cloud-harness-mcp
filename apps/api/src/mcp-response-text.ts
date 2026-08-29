import type { ToolResult } from '@cloud-harness/contracts';

const BLOB_KEYS: Record<string, true> = { content: true, output: true };

function formatArrayItem(item: unknown): string {
  if (item === null || item === undefined) return '';
  if (typeof item !== 'object') return String(item).replaceAll('\0', '\\u0000');
  const record = item as Record<string, unknown>;
  if (typeof record.name === 'string' && typeof record.type === 'string') {
    return `- [${record.type}] ${record.name}`;
  }
  if (typeof record.name === 'string' && typeof record.path === 'string' && typeof record.line === 'number') {
    const kind = typeof record.kind === 'string' ? ` (${record.kind})` : '';
    return `- ${record.name}${kind} ${record.path}:${record.line}`;
  }
  if (typeof record.workspaceId === 'string' && typeof record.status === 'string') {
    const repo = typeof record.repositoryUrl === 'string' ? ` ${record.repositoryUrl}` : '';
    return `- ${record.workspaceId} [${record.status}]${repo}`;
  }
  return `- ${JSON.stringify(record)}`;
}

function formatObjectData(data: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && (BLOB_KEYS[key] || value.includes('\n'))) {
      const sanitized = value.replaceAll('\0', '\\u0000');
      if (sanitized.length === 0) {
        lines.push(`${key}: (no output)`);
      } else {
        lines.push(`${key}:\n${sanitized}`);
      }
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: (empty)`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          const formatted = formatArrayItem(item);
          if (formatted) lines.push(`  ${formatted}`);
        }
      }
    } else if (typeof value === 'object') {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  return lines;
}

function formatData(data: unknown): string[] {
  if (data === null || data === undefined) return [];
  if (typeof data === 'string') {
    const sanitized = data.replaceAll('\0', '\\u0000');
    return sanitized.length === 0 ? ['(no output)'] : [sanitized];
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return ['(empty)'];
    return data.map(formatArrayItem).filter(Boolean);
  }
  if (typeof data === 'object') {
    return formatObjectData(data as Record<string, unknown>);
  }
  return [String(data)];
}

export function formatToolResultText(result: ToolResult): string {
  const sections: string[] = [];
  if (result.message) {
    sections.push(result.message);
  }
  if (result.data !== undefined && result.data !== null) {
    const dataLines = formatData(result.data);
    if (dataLines.length > 0) {
      sections.push(dataLines.join('\n'));
    }
  }
  if (result.error) {
    const details: string[] = [];
    if (result.error.requiredCapability) {
      details.push(`required capability: ${result.error.requiredCapability}`);
    }
    if (result.error.operation) {
      details.push(`operation: ${result.error.operation}`);
    }
    if (result.error.repository) {
      details.push(`repository: ${result.error.repository}`);
    }
    details.push(`retryable: ${result.error.retryable}`);
    sections.push(`Error [${result.error.code}]: ${result.error.message} (${details.join(', ')})`);
  }
  if (result.truncated && result.cursor) {
    sections.push(`[truncated — next cursor: ${result.cursor}]`);
  } else if (result.truncated) {
    sections.push('[truncated — narrow the request]');
  } else if (result.cursor) {
    sections.push(`[next cursor: ${result.cursor}]`);
  }
  return sections.join('\n\n');
}
