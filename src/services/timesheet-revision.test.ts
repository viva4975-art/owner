import { describe, expect, it } from 'vitest';
import { currentAttachments } from './workflow.js';
import { timesheetFilename } from './redacted-timesheet.js';

describe('Berichtigter Stundennachweis', () => {
  const t = {
    site_id: 'x',
    site_no: '2001',
    site_name: 'A',
    address: '',
    from: '2026-10-01',
    to: '2026-10-31',
  };

  it('Dateiname mit Zeitstempel', () => {
    expect(timesheetFilename(t)).toBe('Stundennachweis_2001_2026-10-01_2026-10-31.pdf');
    expect(timesheetFilename(t, '2026-11-03_101500')).toBe(
      'Stundennachweis_2001_2026-10-01_2026-10-31_berichtigt_2026-11-03_101500.pdf',
    );
  });

  it('Mail nimmt nur die neueste Fassung je Objekt, andere Anlagen bleiben', () => {
    const docs = [
      { filename: timesheetFilename(t) },
      { filename: timesheetFilename(t, '2026-11-03_101500') },
      { filename: timesheetFilename(t, '2026-11-04_090000') },
      { filename: timesheetFilename({ ...t, site_no: '2002' }) },
      { filename: 'Arbeitsschein_AS-2026-0001.pdf' },
    ];
    expect(currentAttachments(docs).map((d) => d.filename)).toEqual([
      'Stundennachweis_2001_2026-10-01_2026-10-31_berichtigt_2026-11-04_090000.pdf',
      'Stundennachweis_2002_2026-10-01_2026-10-31.pdf',
      'Arbeitsschein_AS-2026-0001.pdf',
    ]);
  });
});
