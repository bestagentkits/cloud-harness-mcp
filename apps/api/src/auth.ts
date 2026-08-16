import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { ApiConfig } from '@cloud-harness/contracts';

type AuthenticatedRequest = Request & { auth?: AuthInfo };

function equal(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function bearerAuth(config: ApiConfig) {
  return (request: AuthenticatedRequest, response: Response, next: NextFunction): void => {
    const authorization = request.header('authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!equal(token, config.bearerToken)) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="cloud-harness-mcp"');
      response.status(401).json({ error: 'authentication_failed' });
      return;
    }
    request.auth = { token, clientId: config.ownerId, scopes: ['workspace:read', 'workspace:write', 'workspace:execute'] };
    next();
  };
}
