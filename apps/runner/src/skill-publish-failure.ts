import { HarnessError, type ErrorCode } from '@cloud-harness/contracts';
import { SkillRegistryError } from './state-store.js';
import { LocalBundleInputError } from './toolkit-cache-manager.js';

/** How a failed skill create or import is reported: a stable code, its HTTP status, and a safe message. */
export type SkillPublishFailure = {
  code: ErrorCode;
  status: number;
  message: string;
  /** Present when the failure was not caused by the request itself, so the runner should record it. */
  diagnostic?: { name: string; code?: string; syscall?: string; errcode?: number };
};

/**
 * Classifies a failure from publishing a skill package or recording its source, for every create path.
 *
 * A filesystem error's own message names the absolute cache path, so only the operation and errno leave
 * this function. The registry's and the bundle validator's messages describe the request and are kept.
 */
export function classifySkillPublishFailure(error: unknown): SkillPublishFailure {
  // Validation that already chose its code and status (an invalid declared version, for example) is
  // the request's own fault and keeps both.
  if (error instanceof HarnessError) {
    return { code: error.code, status: error.status, message: error.message };
  }
  if (error instanceof SkillRegistryError) {
    return { code: error.code, status: error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' ? 409 : 400, message: error.message };
  }
  if (error instanceof LocalBundleInputError) {
    return { code: 'INVALID_INPUT', status: 400, message: error.message };
  }
  if (error instanceof Error && 'code' in error && typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code)) {
    const syscall = 'syscall' in error && typeof error.syscall === 'string' ? error.syscall : undefined;
    return {
      code: 'UNAVAILABLE',
      status: 503,
      message: `the skill package could not be stored (${syscall ?? 'write'} failed with ${error.code})`,
      diagnostic: { name: error.name, code: error.code, ...(syscall ? { syscall } : {}) }
    };
  }
  // Anything else is a runner fault; the store's own error code (SQLite reports one) helps the operator.
  const storeCode = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const errcode = error instanceof Error && 'errcode' in error && typeof error.errcode === 'number' ? error.errcode : undefined;
  return {
    code: 'INTERNAL_ERROR',
    status: 500,
    message: 'the skill could not be stored',
    diagnostic: {
      name: error instanceof Error ? error.name : 'unknown',
      ...(storeCode ? { code: storeCode } : {}),
      ...(errcode !== undefined ? { errcode } : {})
    }
  };
}
