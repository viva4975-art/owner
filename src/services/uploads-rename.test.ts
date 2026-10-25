import { describe, expect, it } from 'vitest';
import { cleanDisplayName } from './uploads.js';

describe('Dokument umbenennen', () => {
  it('Endung bleibt, verbotene Zeichen fallen weg, gleicher Name = kein eigener Name', () => {
    expect(cleanDisplayName('Vertrag Müller', 'scan_001.pdf')).toBe('Vertrag Müller.pdf');
    expect(cleanDisplayName('Vertrag.pdf', 'scan_001.pdf')).toBe('Vertrag.pdf');
    expect(cleanDisplayName('a/b:c', 'x.docx')).toBe('a b c.docx');
    expect(cleanDisplayName('  ', 'x.pdf')).toBeNull();
    expect(cleanDisplayName('scan_001', 'scan_001.pdf')).toBeNull();
    expect(cleanDisplayName('ohne', 'datei')).toBe('ohne');
  });
});
