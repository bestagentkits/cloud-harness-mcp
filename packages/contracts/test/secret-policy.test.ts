import { describe, expect, it } from 'vitest';
import {
  validateSecretDescription,
  validateSecretName,
  validateSecretValue,
  SecretNameSchema,
  SecretValueSchema,
  SecretDescriptionSchema
} from '../src/secret-policy.js';

describe('secret-policy', () => {
  describe('validateSecretName', () => {
    it('accepts valid secret names', () => {
      expect(validateSecretName('API_KEY')).toEqual({ ok: true, name: 'API_KEY' });
      expect(validateSecretName('database_url')).toEqual({ ok: true, name: 'database_url' });
      expect(validateSecretName('_PRIVATE_VAR')).toEqual({ ok: true, name: '_PRIVATE_VAR' });
      expect(validateSecretName('STRIPE_SECRET_KEY_V2')).toEqual({ ok: true, name: 'STRIPE_SECRET_KEY_V2' });
    });

    it('rejects invalid identifiers', () => {
      expect(validateSecretName('123_INVALID').ok).toBe(false);
      expect(validateSecretName('INVALID-DASH').ok).toBe(false);
      expect(validateSecretName('INVALID SPACE').ok).toBe(false);
      expect(validateSecretName('').ok).toBe(false);
      expect(validateSecretName('a'.repeat(101)).ok).toBe(false);
    });

    it('rejects reserved system and toolchain names', () => {
      expect(validateSecretName('PATH').ok).toBe(false);
      expect(validateSecretName('path').ok).toBe(false);
      expect(validateSecretName('HOME').ok).toBe(false);
      expect(validateSecretName('SHELL').ok).toBe(false);
      expect(validateSecretName('USER').ok).toBe(false);
      expect(validateSecretName('GITHUB_TOKEN').ok).toBe(false);
      expect(validateSecretName('GH_TOKEN').ok).toBe(false);
      expect(validateSecretName('RUNNER_TOKEN').ok).toBe(false);
      expect(validateSecretName('AUTHORIZATION').ok).toBe(false);
      expect(validateSecretName('LD_PRELOAD').ok).toBe(false);
    });

    it('rejects reserved prefixes', () => {
      expect(validateSecretName('HARNESS_API_KEY').ok).toBe(false);
      expect(validateSecretName('CH_CONFIG').ok).toBe(false);
      expect(validateSecretName('CLOUDFLARE_TOKEN').ok).toBe(false);
      expect(validateSecretName('CF_ACCESS_ID').ok).toBe(false);
      expect(validateSecretName('GITHUB_APP_SECRET').ok).toBe(false);
      expect(validateSecretName('ACCESS_TOKEN').ok).toBe(false);
      expect(validateSecretName('RUNNER_INTERNAL').ok).toBe(false);
      expect(validateSecretName('DOCKER_SOCK').ok).toBe(false);
      expect(validateSecretName('XDG_CONFIG_HOME').ok).toBe(false);
      expect(validateSecretName('NPM_CONFIG_CACHE').ok).toBe(false);
      expect(validateSecretName('UV_CACHE_DIR').ok).toBe(false);
      expect(validateSecretName('BUN_INSTALL').ok).toBe(false);
      expect(validateSecretName('PNPM_HOME').ok).toBe(false);
      expect(validateSecretName('GIT_AUTHOR_NAME').ok).toBe(false);
      expect(validateSecretName('NPM_TOKEN').ok).toBe(false);
      expect(validateSecretName('LD_LIBRARY_PATH').ok).toBe(false);
    });
  });

  describe('validateSecretValue', () => {
    it('accepts values between 4 and 65,536 bytes', () => {
      expect(validateSecretValue('abcd')).toEqual({ ok: true, value: 'abcd' });
      expect(validateSecretValue('super-secret-token-12345')).toEqual({ ok: true, value: 'super-secret-token-12345' });
    });

    it('rejects values shorter than 4 bytes', () => {
      expect(validateSecretValue('').ok).toBe(false);
      expect(validateSecretValue('a').ok).toBe(false);
      expect(validateSecretValue('ab').ok).toBe(false);
      expect(validateSecretValue('abc').ok).toBe(false);
    });

    it('rejects values with null or newline bytes', () => {
      expect(validateSecretValue('secret\0value').ok).toBe(false);
      expect(validateSecretValue('secret\nvalue').ok).toBe(false);
      expect(validateSecretValue('secret\rvalue').ok).toBe(false);
    });
    it('rejects values exceeding 65,536 bytes', () => {
      expect(validateSecretValue('x'.repeat(65_537)).ok).toBe(false);
    });
  });

  describe('validateSecretDescription', () => {
    it('handles optional and nullish descriptions', () => {
      expect(validateSecretDescription(undefined)).toEqual({ ok: true, description: null });
      expect(validateSecretDescription(null)).toEqual({ ok: true, description: null });
      expect(validateSecretDescription('')).toEqual({ ok: true, description: null });
      expect(validateSecretDescription('   ')).toEqual({ ok: true, description: null });
    });

    it('accepts valid descriptions', () => {
      expect(validateSecretDescription('Supabase Staging Database')).toEqual({
        ok: true,
        description: 'Supabase Staging Database'
      });
    });

    it('rejects descriptions exceeding 500 chars', () => {
      expect(validateSecretDescription('d'.repeat(501)).ok).toBe(false);
    });

    it('rejects null bytes in description', () => {
      expect(validateSecretDescription('desc\0with-null').ok).toBe(false);
    });
  });

  describe('Zod schemas', () => {
    it('parses valid and throws on invalid', () => {
      expect(SecretNameSchema.parse('STRIPE_KEY')).toBe('STRIPE_KEY');
      expect(SecretValueSchema.parse('my-secret-value')).toBe('my-secret-value');
      expect(() => SecretValueSchema.parse('abc')).toThrow();
      expect(() => SecretValueSchema.parse('')).toThrow();
      expect(SecretDescriptionSchema.parse('My desc')).toBe('My desc');
      expect(SecretDescriptionSchema.parse(null)).toBe(null);
    });
  });
});
