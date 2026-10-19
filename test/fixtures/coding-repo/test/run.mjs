import assert from 'node:assert/strict';
import { greet } from '../src/greeting.mjs';
import { add } from '../src/math.mjs';

// A failed assertion exits non-zero, which is all the verify step reads.
assert.equal(add(2, 3), 5);
assert.equal(greet('Ada'), 'Hello, Ada!');
