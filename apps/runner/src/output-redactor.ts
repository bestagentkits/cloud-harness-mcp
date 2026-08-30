export type SecretEntry = {
  name: string;
  value: string;
};

type OutputMatch = {
  name: string;
  length: number;
};

type TrieNode = {
  next: Map<number, TrieNode>;
  fail: TrieNode | null;
  output: OutputMatch[];
  depth: number;
};

function createNode(depth = 0): TrieNode {
  return {
    next: new Map(),
    fail: null,
    output: [],
    depth
  };
}

export class StreamRedactor {
  private currentNode: TrieNode;
  private holdback: Buffer = Buffer.alloc(0);

  constructor(
    private readonly root: TrieNode,
    private readonly hasPatterns: boolean
  ) {
    this.currentNode = root;
  }

  processChunk(chunk: Buffer): Buffer {
    if (!this.hasPatterns || chunk.length === 0) {
      if (this.holdback.length === 0) return chunk;
      const combined = Buffer.concat([this.holdback, chunk]);
      this.holdback = Buffer.alloc(0);
      return combined;
    }

    const input = this.holdback.length > 0 ? Buffer.concat([this.holdback, chunk]) : chunk;
    const outputParts: Buffer[] = [];
    let safeOffset = 0;
    let i = 0;
    let pendingMatch: { name: string; matchStart: number; matchEnd: number } | null = null;

    while (i < input.length) {
      const byte = input[i]!;

      // Check if current node can advance with byte
      if (this.currentNode.next.has(byte)) {
        this.currentNode = this.currentNode.next.get(byte)!;
        if (this.currentNode.output.length > 0) {
          const match = this.currentNode.output[0]!;
          pendingMatch = {
            name: match.name,
            matchStart: i - match.length + 1,
            matchEnd: i + 1
          };
        }
        i++;
      } else {
        // Cannot advance directly with byte
        if (pendingMatch) {
          // Commit the pending match
          if (pendingMatch.matchStart > safeOffset) {
            outputParts.push(input.subarray(safeOffset, pendingMatch.matchStart));
          }
          outputParts.push(Buffer.from(`[REDACTED_SECRET: ${pendingMatch.name}]`, 'utf8'));
          safeOffset = pendingMatch.matchEnd;
          i = safeOffset;
          this.currentNode = this.root;
          pendingMatch = null;
        } else if (this.currentNode !== this.root) {
          // Fall back via failure link without advancing i
          this.currentNode = this.currentNode.fail ?? this.root;
        } else {
          // At root and cannot match byte
          i++;
        }
      }
    }

    if (pendingMatch) {
      // If pending match is completely contained in input and no further extension is possible in trie
      if (this.currentNode.next.size === 0) {
        if (pendingMatch.matchStart > safeOffset) {
          outputParts.push(input.subarray(safeOffset, pendingMatch.matchStart));
        }
        outputParts.push(Buffer.from(`[REDACTED_SECRET: ${pendingMatch.name}]`, 'utf8'));
        safeOffset = pendingMatch.matchEnd;
        this.currentNode = this.root;
        pendingMatch = null;
      }
    }

    const holdStart = pendingMatch
      ? Math.min(pendingMatch.matchStart, input.length - this.currentNode.depth)
      : (this.currentNode.depth > 0 ? input.length - this.currentNode.depth : input.length);

    const actualHoldStart = Math.max(safeOffset, holdStart);
    if (actualHoldStart > safeOffset) {
      outputParts.push(input.subarray(safeOffset, actualHoldStart));
    }
    this.holdback = Buffer.from(input.subarray(actualHoldStart));

    return Buffer.concat(outputParts);
  }

  flush(): Buffer {
    if (this.holdback.length === 0) return Buffer.alloc(0);
    const input = this.holdback;
    this.holdback = Buffer.alloc(0);
    this.currentNode = this.root;

    // Scan whatever is in holdback to commit any complete match
    const outputParts: Buffer[] = [];
    let safeOffset = 0;
    let i = 0;
    let pendingMatch: { name: string; matchStart: number; matchEnd: number } | null = null;

    while (i < input.length) {
      const byte = input[i]!;
      if (this.currentNode.next.has(byte)) {
        this.currentNode = this.currentNode.next.get(byte)!;
        if (this.currentNode.output.length > 0) {
          const match = this.currentNode.output[0]!;
          pendingMatch = {
            name: match.name,
            matchStart: i - match.length + 1,
            matchEnd: i + 1
          };
        }
        i++;
      } else {
        if (pendingMatch) {
          if (pendingMatch.matchStart > safeOffset) {
            outputParts.push(input.subarray(safeOffset, pendingMatch.matchStart));
          }
          outputParts.push(Buffer.from(`[REDACTED_SECRET: ${pendingMatch.name}]`, 'utf8'));
          safeOffset = pendingMatch.matchEnd;
          i = safeOffset;
          this.currentNode = this.root;
          pendingMatch = null;
        } else if (this.currentNode !== this.root) {
          this.currentNode = this.currentNode.fail ?? this.root;
        } else {
          i++;
        }
      }
    }

    if (pendingMatch) {
      if (pendingMatch.matchStart > safeOffset) {
        outputParts.push(input.subarray(safeOffset, pendingMatch.matchStart));
      }
      outputParts.push(Buffer.from(`[REDACTED_SECRET: ${pendingMatch.name}]`, 'utf8'));
      safeOffset = pendingMatch.matchEnd;
    }

    if (safeOffset < input.length) {
      outputParts.push(input.subarray(safeOffset));
    }

    return Buffer.concat(outputParts);
  }
}

export class SecretSnapshotRedactor {
  private readonly root: TrieNode;
  private readonly patterns: SecretEntry[];

  constructor(secrets: Record<string, string> = {}) {
    const raw: SecretEntry[] = [];
    for (const [name, value] of Object.entries(secrets)) {
      if (typeof value === 'string' && value.length > 0) {
        raw.push({ name, value });
      }
    }
    // Sort by byte length descending
    this.patterns = raw.sort((a, b) => Buffer.byteLength(b.value, 'utf8') - Buffer.byteLength(a.value, 'utf8'));

    this.root = createNode(0);
    this.buildTrie();
  }

  get active(): boolean {
    return this.patterns.length > 0;
  }

  createStream(): StreamRedactor {
    return new StreamRedactor(this.root, this.active);
  }

  sanitizeString(text: string): string {
    if (!this.active || !text) return text;
    let result = text;
    for (const pattern of this.patterns) {
      if (result.includes(pattern.value)) {
        result = result.split(pattern.value).join(`[REDACTED_SECRET: ${pattern.name}]`);
      }
    }
    return result;
  }

  sanitizeObject<T>(value: T): T {
    if (!this.active || value === null || value === undefined) return value;
    if (typeof value === 'string') {
      return this.sanitizeString(value) as unknown as T;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeObject(item)) as unknown as T;
    }
    if (typeof value === 'object') {
      const sanitized: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        sanitized[k] = this.sanitizeObject(v);
      }
      return sanitized as T;
    }
    return value;
  }

  private buildTrie(): void {
    for (const pattern of this.patterns) {
      const bytes = Buffer.from(pattern.value, 'utf8');
      let current = this.root;
      for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i]!;
        let nextNode = current.next.get(byte);
        if (!nextNode) {
          nextNode = createNode(current.depth + 1);
          current.next.set(byte, nextNode);
        }
        current = nextNode;
      }
      current.output.push({ name: pattern.name, length: bytes.length });
    }

    const queue: TrieNode[] = [];
    for (const child of this.root.next.values()) {
      child.fail = this.root;
      queue.push(child);
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const [byte, child] of current.next.entries()) {
        let fallback = current.fail;
        while (fallback !== null && !fallback.next.has(byte)) {
          fallback = fallback.fail;
        }
        child.fail = fallback ? (fallback.next.get(byte) ?? this.root) : this.root;
        if (child.fail.output.length > 0) {
          child.output.push(...child.fail.output);
        }
        queue.push(child);
      }
    }
  }
}
