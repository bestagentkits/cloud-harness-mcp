import { describe, expect, it } from 'vitest';
import { serverVersionFrom } from './sidebar-version';

function docWith(content: string | undefined): Pick<Document, 'querySelector'> {
  const doc = document.implementation.createHTMLDocument('t');
  if (content !== undefined) {
    const meta = doc.createElement('meta');
    meta.name = 'ch-server-version';
    meta.content = content;
    doc.head.append(meta);
  }
  return doc;
}

describe('sidebar server version', () => {
  it('reads the version the API injected into the shell', () => {
    expect(serverVersionFrom(docWith('2.0.1'))).toBe('2.0.1');
    expect(serverVersionFrom(docWith('1.2.3-beta.4+build.7'))).toBe('1.2.3-beta.4+build.7');
  });

  it('treats a missing tag, the unfilled placeholder or unexpected text as no version', () => {
    expect(serverVersionFrom(docWith(undefined))).toBeUndefined();
    expect(serverVersionFrom(docWith('__CH_VERSION__'))).toBeUndefined();
    expect(serverVersionFrom(docWith('<b>1</b>'))).toBeUndefined();
    expect(serverVersionFrom(docWith(''))).toBeUndefined();
  });
});
