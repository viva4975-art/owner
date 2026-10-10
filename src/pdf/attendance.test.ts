import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { monthLabel, nextMonth, renderAttendancePdf } from './attendance.js';

describe('Anwesenheitsliste (zwei Monate je Seite)', () => {
  it('rechnet Monate über den Jahreswechsel', () => {
    expect(nextMonth('2026-12')).toBe('2027-01');
    expect(nextMonth('2026-02')).toBe('2026-03');
    expect(monthLabel('2027-01')).toBe('Januar 2027');
  });

  it('erzeugt je zwei Monate eine Seite im Querformat', async () => {
    const bytes = await renderAttendancePdf({
      site: { name: 'Grundschule', site_no: '2000101', address: 'Am Gern 5, 80638 München' },
      customer: 'Landeshauptstadt München',
      month: '2026-11',
      pages: 2,
      company: 'Viva-Deluxe Gebäudereinigung GmbH',
    });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(2);
    const { width, height } = pdf.getPage(0).getSize();
    expect(width).toBeGreaterThan(height);
    expect(pdf.getTitle()).toContain('November 2026');
  });
});
