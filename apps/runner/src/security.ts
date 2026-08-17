import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

export function constantTimeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function serviceAuth(expected: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const authorization = request.header('authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!constantTimeEqual(token, expected)) {
      response.status(401).json({ error: 'authentication failed' });
      return;
    }
    next();
  };
}
