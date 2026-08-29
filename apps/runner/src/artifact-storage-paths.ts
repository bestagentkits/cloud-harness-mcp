import { randomBytes } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync,
  renameSync, unlinkSync, writeSync
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const artifactFile = /^(art_[A-Za-z0-9_-]{32})\.snapshot$/;
const temporaryFile = /^\.tmp-art_[A-Za-z0-9_-]{32}-[a-f0-9]{16}$/;
const tombstoneFile = /^\.deleting-(art_[A-Za-z0-9_-]{32})-[1-9][0-9]*-[a-f0-9]{16}$/;

export type StagedArtifact = { temporaryPath: string; targetPath: string; relativePath: string };
export type StagedDeletion = { tombstonePath: string; targetPath: string };

export class ArtifactStoragePaths {
  readonly root: string;
  readonly objectsRoot: string;

  constructor(root: string, database: DatabaseSync) {
    const requestedRoot = resolve(root);
    mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
    if (lstatSync(requestedRoot).isSymbolicLink()) throw new Error('artifact root must not be a symbolic link');
    this.root = realpathSync(requestedRoot);
    this.objectsRoot = join(this.root, 'objects');
    mkdirSync(this.objectsRoot, { recursive: true, mode: 0o700 });
    if (lstatSync(this.objectsRoot).isSymbolicLink() || realpathSync(this.objectsRoot) !== this.objectsRoot) {
      throw new Error('artifact objects root is not canonical');
    }
    database.exec('BEGIN IMMEDIATE');
    try {
      this.reconcile(database);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  stage(artifactId: string, content: Buffer): StagedArtifact {
    const relativePath = `objects/${artifactId}.snapshot`;
    const targetPath = this.resolveRelative(relativePath);
    const temporaryPath = join(this.objectsRoot, `.tmp-${artifactId}-${randomBytes(8).toString('hex')}`);
    try {
      const descriptor = openSync(temporaryPath, 'wx', 0o600);
      try {
        writeSync(descriptor, content);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    } catch (error) {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      throw error;
    }
    return { temporaryPath, targetPath, relativePath };
  }

  commitStage(staged: StagedArtifact): void {
    linkSync(staged.temporaryPath, staged.targetPath);
    unlinkSync(staged.temporaryPath);
  }

  discardStage(staged: StagedArtifact, committed: boolean): void {
    if (existsSync(staged.temporaryPath)) unlinkSync(staged.temporaryPath);
    if (committed && existsSync(staged.targetPath)) unlinkSync(staged.targetPath);
  }

  stageDeletion(relativePath: string, artifactId: string, generation: number): StagedDeletion {
    const targetPath = this.resolveRelative(relativePath);
    this.assertSafeExistingFile(targetPath);
    const tombstonePath = join(this.objectsRoot, `.deleting-${artifactId}-${generation}-${randomBytes(8).toString('hex')}`);
    renameSync(targetPath, tombstonePath);
    return { tombstonePath, targetPath };
  }

  finishDeletion(staged: StagedDeletion): void {
    if (existsSync(staged.tombstonePath)) unlinkSync(staged.tombstonePath);
  }

  rollbackDeletion(staged: StagedDeletion): void {
    if (existsSync(staged.tombstonePath) && !existsSync(staged.targetPath)) renameSync(staged.tombstonePath, staged.targetPath);
  }
  resolveExisting(relativePath: string): string {
    const targetPath = this.resolveRelative(relativePath);
    this.assertSafeExistingFile(targetPath);
    return targetPath;
  }

  resolveRelative(relativePath: string): string {
    if (!/^objects\/art_[A-Za-z0-9_-]{32}\.snapshot$/.test(relativePath)) throw new Error('unsafe artifact storage path');
    const target = resolve(this.root, relativePath);
    if (!target.startsWith(`${this.objectsRoot}${sep}`) || relative(this.objectsRoot, target).startsWith('..')) {
      throw new Error('unsafe artifact storage path');
    }
    return target;
  }

  assertSafeExistingFile(path: string): void {
    const actual = realpathSync(path);
    if (!actual.startsWith(`${this.objectsRoot}${sep}`) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
      throw new Error('unsafe artifact storage path');
    }
  }

  private reconcile(database: DatabaseSync): void {
    for (const name of readdirSync(this.objectsRoot)) {
      const path = join(this.objectsRoot, name);
      if (temporaryFile.test(name)) {
        this.assertSafeExistingFile(path);
        unlinkSync(path);
        continue;
      }
      const tombstone = tombstoneFile.exec(name);
      if (tombstone) {
        this.assertSafeExistingFile(path);
        const artifactId = tombstone[1]!;
        const row = database.prepare('SELECT relative_path FROM artifacts WHERE id = ?').get(artifactId) as { relative_path: string } | undefined;
        if (row) {
          const target = this.resolveRelative(row.relative_path);
          if (!existsSync(target)) renameSync(path, target);
          else unlinkSync(path);
        } else unlinkSync(path);
        continue;
      }
      const artifact = artifactFile.exec(name);
      if (!artifact) throw new Error('unexpected file in artifact objects root');
      this.assertSafeExistingFile(path);
      const row = database.prepare('SELECT relative_path FROM artifacts WHERE id = ?').get(artifact[1]!) as { relative_path: string } | undefined;
      if (!row) unlinkSync(path);
      else if (row.relative_path !== `objects/${name}`) throw new Error('artifact metadata path mismatch');
    }
  }
}
