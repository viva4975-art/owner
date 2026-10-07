import { todayBerlin } from '../domain/invoice/calc.js';
import { renderTablePdf } from '../pdf/table.js';
import { type MissingRow, REQUIRED_DOCS, missingDocs } from '../services/hr-required-docs.js';
import type { Ctx } from './app.js';
import { PageHead, dateDe } from './layout.js';

/*
 * Personal → Fehlende Unterlagen: alle aktiven Mitarbeitenden mit fehlenden Pflichtunterlagen, sortiert nach
 * Objektleitung (je Objektleitung eine Liste zum Nachfassen), Filter, Export CSV/PDF.
 */
const ITEMS = [...REQUIRED_DOCS, 'Aufenthaltstitel', 'Staatsangehörigkeit'];

/** Je Objektleitung eine Zeile pro Mitarbeiter (wer an Objekten mehrerer Objektleitungen arbeitet, steht bei jeder). */
function byManager(rows: MissingRow[], manager: string, item: string) {
  const out: { manager: string; r: MissingRow }[] = [];
  for (const r of rows) {
    if (item && !r.missing.some((m) => m.startsWith(item))) continue;
    for (const m of r.managers) if (!manager || m === manager) out.push({ manager: m, r });
  }
  return out.sort(
    (a, b) =>
      Number(a.manager.startsWith('ohne ')) - Number(b.manager.startsWith('ohne ')) ||
      a.manager.localeCompare(b.manager, 'de') ||
      a.r.name.localeCompare(b.r.name, 'de'),
  );
}

const csvSafe = (v: string) => {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function registerHrRequiredRoutes({ app, deps, page }: Ctx) {
  const { sql } = deps;

  const load = async (q: (k: string) => string | undefined) => {
    const all = await missingDocs(sql);
    const managers = [...new Set(all.flatMap((r) => r.managers))].sort((a, b) => a.localeCompare(b, 'de'));
    const manager = q('objektleitung') ?? '';
    const item = q('fehlt') ?? '';
    return { all, managers, manager, item, list: byManager(all, manager, item) };
  };

  app.get('/personal/unterlagen', async (c) => {
    const d = await load((k) => c.req.query(k));
    const qs = new URLSearchParams({ objektleitung: d.manager, fehlt: d.item }).toString();
    let last = '';
    return page(
      c,
      'Fehlende Unterlagen',
      'personal',
      <>
        <PageHead title="Fehlende Pflichtunterlagen">
          <a class="btn sec" href={`/personal/unterlagen.csv?${qs}`}>
            CSV
          </a>
          <a class="btn sec" href={`/personal/unterlagen.pdf?${qs}`} target="_blank">
            PDF
          </a>
        </PageHead>
        <p class="mut" style="margin-top:-6px">
          Pflicht: {REQUIRED_DOCS.join(', ')} – dazu Aufenthaltstitel/Arbeitserlaubnis außerhalb
          EU/EWR/Schweiz (nicht abgelaufen). Kleidung und Schlüssel zählen auch über Übergaben. {d.all.length}{' '}
          von den aktiven Mitarbeitenden haben Lücken.
        </p>
        <form method="get" class="actions" style="margin-top:0">
          <select
            name="objektleitung"
            onchange="this.form.submit()"
            aria-label="Objektleitung"
            style="max-width:260px"
          >
            <option value="">alle Objektleitungen</option>
            {d.managers.map((m) => (
              <option value={m} selected={m === d.manager}>
                {m}
              </option>
            ))}
          </select>
          <select
            name="fehlt"
            onchange="this.form.submit()"
            aria-label="fehlt"
            data-nosearch
            style="max-width:260px"
          >
            <option value="">alles, was fehlt</option>
            {ITEMS.map((m) => (
              <option value={m} selected={m === d.item}>
                fehlt: {m}
              </option>
            ))}
          </select>
        </form>
        {d.list.length === 0 ? (
          <div class="empty">Keine fehlenden Unterlagen für diese Auswahl.</div>
        ) : (
          <div class="tbl">
            <table class="stack-m">
              <thead>
                <tr>
                  <th>Objektleitung</th>
                  <th>Mitarbeiter</th>
                  <th>Objekte</th>
                  <th>fehlt</th>
                </tr>
              </thead>
              <tbody>
                {d.list.map(({ manager, r }) => {
                  const head = manager !== last;
                  last = manager;
                  return (
                    <tr style={head ? 'border-top:2px solid var(--line-2)' : ''}>
                      <td data-l="Objektleitung">
                        {head ? <b>{manager}</b> : <span class="mut small">″</span>}
                      </td>
                      <td data-l="Mitarbeiter">
                        <a href={`/personal/${r.employee_id}/dokumente`}>{r.name}</a>{' '}
                        <span class="small mut">{r.personnel_no}</span>
                      </td>
                      <td data-l="Objekte" class="small">
                        {r.sites.join(', ') || '–'}
                      </td>
                      <td data-l="fehlt">
                        {r.missing.map((m) => (
                          <span class="badge err" style="margin:0 4px 4px 0">
                            {m}
                          </span>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </>,
    );
  });

  app.get('/personal/unterlagen.csv', async (c) => {
    const d = await load((k) => c.req.query(k));
    const lines = [
      ['Objektleitung', 'Personalnr.', 'Name', 'Objekte', 'fehlt'].join(';'),
      ...d.list.map(({ manager, r }) =>
        [manager, r.personnel_no, r.name, r.sites.join(', '), r.missing.join(', ')].map(csvSafe).join(';'),
      ),
    ];
    return new Response(`\uFEFF${lines.join('\r\n')}\r\n`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="fehlende-unterlagen-${todayBerlin()}.csv"`,
        'Cache-Control': 'private, no-store',
      },
    });
  });

  app.get('/personal/unterlagen.pdf', async (c) => {
    const d = await load((k) => c.req.query(k));
    const rows: Parameters<typeof renderTablePdf>[0]['rows'] = [];
    let last = '';
    for (const { manager, r } of d.list) {
      if (manager !== last) rows.push({ section: manager });
      last = manager;
      rows.push([r.personnel_no, r.name, r.sites.join(', '), r.missing.join(', ')]);
    }
    const pdf = await renderTablePdf({
      title: 'Fehlende Pflichtunterlagen',
      subtitle: `Stand ${dateDe(todayBerlin())}${d.manager ? ` · Objektleitung ${d.manager}` : ''}${d.item ? ` · fehlt: ${d.item}` : ''}`,
      columns: [
        { label: 'Pers.-Nr.', width: 60 },
        { label: 'Name', width: 170 },
        { label: 'Objekte', width: 250 },
        { label: 'fehlt', width: 300 },
      ],
      rows,
      footnote: 'Vertraulich – Personaldaten. Unterlagen bitte in der Personalakte (Dokumente) ablegen.',
    });
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="fehlende-unterlagen-${todayBerlin()}.pdf"`,
        'Cache-Control': 'private, no-store',
      },
    });
  });
}
