import type { Child, FC } from 'hono/jsx';
import { formatEuro, type Cents } from '../domain/money/money.js';
import { formatDateDe } from '../domain/invoice/calc.js';

const CSS = `
:root{--bx:#7D1435;--bx2:#8B2332;--bx-l:#f6edf0;--ink:#1d1d1f;--mut:#6b6b70;--line:#e3dfe0;--bg:#faf8f8;--ok:#1f7a4a;--warn:#a15c00;--err:#b3261e}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
header{background:var(--bx);color:#fff}
header .in{max-width:1200px;margin:0 auto;padding:0 16px;display:flex;align-items:center;gap:28px;height:56px}
header .logo{font-weight:800;letter-spacing:.06em}
header nav a{color:#f3dbe3;text-decoration:none;margin-right:18px;font-weight:500}
header nav a.on,header nav a:hover{color:#fff;border-bottom:2px solid #fff;padding-bottom:3px}
header .env{margin-left:auto;font-size:12px;background:#fff;color:var(--bx);padding:2px 8px;border-radius:10px;font-weight:700}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:24px;margin:0 0 16px;color:var(--bx)}
h2{font-size:18px;margin:28px 0 10px}
a{color:var(--bx2)}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:18px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px 16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px}
.stat{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px}
.stat b{display:block;font-size:24px;color:var(--bx)}
.stat span{color:var(--mut);font-size:13px}
table{width:100%;border-collapse:collapse;background:#fff}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);font-weight:600;background:#fcfafa}
td.r,th.r{text-align:right;white-space:nowrap}
tr:hover td{background:#fdf9fa}
.tbl{border:1px solid var(--line);border-radius:10px;overflow:auto}
label{display:block;font-size:13px;color:var(--mut);margin-bottom:4px;font-weight:500}
input,select,textarea{width:100%;padding:8px 10px;border:1px solid #cfc8ca;border-radius:6px;font:inherit;background:#fff}
input:focus,select:focus,textarea:focus{outline:2px solid var(--bx-l);border-color:var(--bx)}
textarea{min-height:60px}
.chk{display:flex;gap:8px;align-items:center}.chk input{width:auto}
.btn{display:inline-block;background:var(--bx);color:#fff;border:0;border-radius:6px;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.btn:hover{background:var(--bx2)}
.btn.sec{background:#fff;color:var(--bx);border:1px solid var(--bx)}
.btn.danger{background:#fff;color:var(--err);border:1px solid var(--err)}
.btn.sm{padding:5px 10px;font-size:13px}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0}
.actions form{margin:0}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;font-weight:600;background:#eee;color:#444}
.badge.draft{background:#fff4e0;color:var(--warn)}
.badge.issued{background:#e6f4ec;color:var(--ok)}
.badge.sent{background:#e7eefb;color:#2856a5}
.badge.failed,.badge.err{background:#fde8e7;color:var(--err)}
.badge.kind{background:var(--bx-l);color:var(--bx)}
.flash{padding:12px 14px;border-radius:8px;margin-bottom:16px;white-space:pre-wrap}
.flash.ok{background:#e6f4ec;color:#145232;border:1px solid #b7dcc6}
.flash.err{background:#fde8e7;color:#7a1712;border:1px solid #f2b8b5}
.mut{color:var(--mut)}.small{font-size:13px}
.lines input,.lines select{padding:6px 8px}
.lines td{padding:6px}
.right{text-align:right}
.totals{margin-left:auto;max-width:360px}
.totals td{border:0;padding:3px 10px}
.totals tr.sum td{font-weight:700;color:var(--bx);border-top:1px solid var(--line)}
.hint{background:var(--bx-l);border-left:3px solid var(--bx);padding:10px 12px;border-radius:4px;font-size:14px}
@media (max-width:700px){header .in{gap:12px;overflow:auto}header nav a{margin-right:10px}}
`;

export const euro = (c: bigint) => formatEuro(c as Cents);
export const dateDe = (d: string | null | undefined) => (d ? formatDateDe(d) : '–');

export const Layout: FC<{
  title: string;
  nav: string;
  env: string;
  flash?: { ok?: string | undefined; err?: string | undefined };
  children?: Child;
}> = ({ title, nav, env, flash, children }) => (
  <html lang="de">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{`${title} · Viva-Deluxe`}</title>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body>
      <header>
        <div class="in">
          <span class="logo">VIVA-DELUXE</span>
          <nav>
            {[
              ['/', 'Übersicht', 'home'],
              ['/rechnungen', 'Rechnungen', 'rechnungen'],
              ['/kunden', 'Kunden', 'kunden'],
              ['/objekte', 'Objekte', 'objekte'],
            ].map(([href, label, key]) => (
              <a href={href} class={nav === key ? 'on' : ''}>
                {label}
              </a>
            ))}
          </nav>
          <span class="env">{env === 'live' ? 'LIVE' : env === 'test' ? 'TEST' : 'LOKAL'}</span>
        </div>
      </header>
      <main>
        {flash?.ok && <div class="flash ok">{flash.ok}</div>}
        {flash?.err && <div class="flash err">{flash.err}</div>}
        {children}
      </main>
    </body>
  </html>
);

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Entwurf',
  issued: 'Ausgestellt',
  sent: 'Versendet',
  pending: 'Versand läuft',
  failed: 'Versand fehlgeschlagen',
};

export const FORMAT_LABEL: Record<string, string> = {
  pdf: 'PDF',
  zugferd: 'ZUGFeRD',
  xrechnung: 'XRechnung + PDF',
};

export const SERVICE_KIND_LABEL: Record<string, string> = {
  monthly_flat: 'Monatspauschale',
  special: 'Sonderleistung',
  hourly: 'Regiestunden',
};
