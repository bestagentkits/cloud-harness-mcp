# Files and code search

Use these tools for bounded workspace inspection and mutation. Prefer them over
shell commands because their paths, sizes, concurrency checks, and results are
validated by Cloud Harness.

## File inspection

<!-- cloudharness-tool:files_list -->
### `files_list`

List one directory without recursively walking it.

- Input: `workspaceId`; `path` defaults to `.`; optional `cursor`; `limit`
  defaults to 100 and permits 1–500.
- Returns entries with `name` and `type`, plus a cursor when another page exists.
- A page can change between calls when another operation edits the directory.

<!-- cloudharness-tool:files_read -->
### `files_read`

Read a byte range from one file.

- Input: `workspaceId`, `path`; `offset` defaults to 0; `limit` defaults to
  65,536 bytes and permits 1–262,144.
- Returns text `content`, total `bytes`, and the file's lowercase `sha256`.
- When truncated, use the returned byte-offset cursor with the next call's
  `offset`. Text characters can occupy multiple bytes, so do not derive the
  next offset from the displayed character count.

<!-- cloudharness-example:files_read
{"workspaceId":"ws_aaaaaaaaaaaaaaaaaaaa","path":"src/config.ts","offset":0,"limit":65536}
-->

## File mutation

<!-- cloudharness-tool:files_write -->
### `files_write`

Atomically replace or create a file.

- Required: `workspaceId`, `path`, `content` (at most 1,048,576 characters).
- Optional: `expectedSha256`, exactly 64 characters. When supplied, the target
  must exist and match; otherwise the result is `CONFLICT`.
- Returns final byte count and SHA-256. Parent directories are not implied;
  create them first when needed.
- This replaces the complete file. Re-read and use the current hash before
  overwriting a file that another actor may edit.

<!-- cloudharness-tool:files_apply_patch -->
### `files_apply_patch`

Replace one unique exact text occurrence in a file.

- Required: `workspaceId`, `path`, `oldText`, `newText`; each text field permits
  at most 262,144 characters.
- Optional: `expectedSha256`, exactly 64 characters.
- `oldText` must occur exactly once. Missing, repeated, or stale content returns
  `CONFLICT`; this input is not a unified diff.
- Returns the path and final SHA-256.

<!-- cloudharness-example:files_apply_patch
{"workspaceId":"ws_aaaaaaaaaaaaaaaaaaaa","path":"src/config.ts","oldText":"const retries = 2;","newText":"const retries = 3;","expectedSha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}
-->

<!-- cloudharness-tool:files_delete -->
### `files_delete`

Delete one file or directory below the workspace root.

- Required: `workspaceId`, entry `path`; `recursive` defaults to `false`.
- Optional `expectedSha256` protects file deletion only. It is invalid for a
  directory and returns `CONFLICT` when the file changed.
- A directory requires `recursive: true`. Review the exact path first; deleted
  uncommitted content is not recoverable from Cloud Harness.

<!-- cloudharness-tool:files_move -->
### `files_move`

Move or rename one entry below the workspace root.

- Required: `workspaceId`, `source`, `destination`; `overwrite` defaults to
  `false`.
- Existing destinations cause `CONFLICT` unless file overwrite is explicitly
  allowed. Directory overwrite is not supported.
- Moving an entry to the same path succeeds without changing it.

<!-- cloudharness-tool:files_mkdir -->
### `files_mkdir`

Create a directory below the workspace root.

- Required: `workspaceId`, entry `path`; `recursive` defaults to `true`.
- Repeating a successful call is safe. With `recursive: false`, the parent must
  already exist.

## Search

<!-- cloudharness-tool:grep_search -->
### `grep_search`

Run bounded regular-expression text search.

- Required: `workspaceId`, `pattern` (1–4,096 characters).
- Optional: `path` defaults to `.`, `glob` permits at most 512 characters,
  `maxResults` defaults to 100 and permits 1–500.
- Results contain matching paths, line numbers, and bounded line text. The
  pattern uses ripgrep-compatible regular-expression behavior.
- If truncated, narrow `path`, `glob`, or pattern; search results do not provide
  a continuation cursor.

<!-- cloudharness-example:grep_search
{"workspaceId":"ws_aaaaaaaaaaaaaaaaaaaa","pattern":"TODO|FIXME","path":"src","glob":"*.ts","maxResults":100}
-->

<!-- cloudharness-tool:symbols_search -->
### `symbols_search`

Find indexed symbol definitions.

- Required: `workspaceId`, `query` (1–256 characters).
- Optional: `path` defaults to `.`, `language` is a 1–40 character language
  label, `maxResults` defaults to 100 and permits 1–500.
- Matching is case-insensitive substring search over generated symbol data. It
  is not a language-server type or semantic query.

<!-- cloudharness-tool:symbols_references -->
### `symbols_references`

Find lexical whole-word occurrences of a symbol.

- Required: `workspaceId`, `symbol` (1–256 characters, no newline or NUL).
- Optional: `path` defaults to `.`, `glob` permits at most 512 characters,
  `maxResults` defaults to 100 and permits 1–500.
- This fixed-word search can include definitions, comments, and strings. Verify
  each result before editing; it does not prove a semantic reference.

## Safe edit loop

1. Read the current file and retain its SHA-256.
2. Make the smallest exact replacement with that hash.
3. On `CONFLICT`, re-read; never remove the hash merely to force the write.
4. Read or diff the result before executing or committing it.
