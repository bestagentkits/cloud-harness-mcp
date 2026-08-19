import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import type { SiteConfig } from 'vitepress';

/**
 * Strips frontmatter block (---...---) from a Markdown string.
 */
export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) return content;
  return content.slice(match[0].length);
}

/**
 * Recursively scans directory for .md files.
 */
async function getMarkdownFiles(dir: string, baseDir: string = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.vitepress' || entry.name === 'node_modules') continue;
      files.push(...(await getMarkdownFiles(fullPath, baseDir)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Hook to emit .md twins and llms-full.txt into the VitePress outDir.
 */
export async function emitMarkdownTwins(siteConfig: SiteConfig): Promise<void> {
  const srcDir = siteConfig.srcDir;
  const outDir = siteConfig.outDir;

  const mdFiles = await getMarkdownFiles(srcDir);
  const fullContentParts: string[] = [];

  for (const file of mdFiles) {
    const relPath = relative(srcDir, file);
    const destPath = join(outDir, relPath);

    await mkdir(dirname(destPath), { recursive: true });

    const rawContent = await readFile(file, 'utf8');
    const cleanContent = stripFrontmatter(rawContent).trim();

    await writeFile(destPath, cleanContent + '\n', 'utf8');

    fullContentParts.push(`\n\n# Document: /${relPath.replace(/\.md$/, '')}\n\n${cleanContent}`);
  }

  // Also write llms-full.txt
  const llmsFullHeader = `# Cloud Harness MCP - Full Documentation\n\n> Complete Markdown documentation export for AI crawlers and LLM analysis.\n`;
  await writeFile(join(outDir, 'llms-full.txt'), llmsFullHeader + fullContentParts.join('\n\n---\n\n') + '\n', 'utf8');

  console.log(`✓ Emitted ${mdFiles.length} Markdown twins and llms-full.txt into ${outDir}`);
}
