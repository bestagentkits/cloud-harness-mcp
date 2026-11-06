import { describe, expect, it } from 'vitest';
import { networkSelection, readinessMessage, readNetworkProfile, readReadiness } from './network-model';
import { readTypesafeCredential, readTypesafeStatus } from './typesafe-model';

describe('default network profile', () => {
  it('selects the stored profile and falls back to the runner default', () => {
    const stored = readNetworkProfile({ value: 'network-none', source: 'setting' });
    expect(stored).toEqual({ value: 'network-none', stored: true });
    expect(networkSelection(stored)).toBe('network-none');
    const runner = readNetworkProfile({ value: 'dependency-access', source: 'environment' });
    expect(networkSelection(runner)).toBe('');
    // Anything unknown reads as the shipped default; a raw bridge is never selectable.
    expect(readNetworkProfile({ value: 'bridge', source: 'setting' }).value).toBe('dependency-access');
    expect(readNetworkProfile(undefined)).toEqual({ value: 'dependency-access', stored: false });
  });

  it('words the readiness probe result', () => {
    expect(readinessMessage(readReadiness({ ready: true, reason: null }))).toBe('Egress readiness confirmed.');
    expect(readinessMessage(readReadiness({ ready: false, reason: 'proxy down' }))).toBe('Egress is not ready: proxy down');
    expect(readinessMessage(readReadiness({}))).toBe('Egress is not ready: the readiness probe reported no reason');
  });
});

describe('TypeSafe read side', () => {
  it('keeps only display fields of status and credential', () => {
    expect(readTypesafeStatus({ configured: true, enabled: false, endpoint: 'https://api.typesafe.example', model: 'm1', extra: 1 }))
      .toEqual({ configured: true, enabled: false, endpoint: 'https://api.typesafe.example', model: 'm1' });
    const credential = readTypesafeCredential({ credentials: [{ id: 'cred_1', integration: 'other' }, { id: 'cred_2', integration: 'typesafe', label: 'TypeSafe', activeVersion: 2, generation: 4 }] });
    expect(credential).toEqual({ label: 'TypeSafe', activeVersion: 2 });
    expect(readTypesafeCredential({ credentials: [] })).toBeUndefined();
    expect(readTypesafeCredential(null)).toBeUndefined();
  });
});
