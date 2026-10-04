import { createHash } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { type Cents, toXmlDecimal } from '../domain/money/money.js';
import { addDays, holidayName, isoWeekday } from '../domain/time/holidays.js';
import { settleDebitRunTx } from './bank.js';
import { assertVersion } from './crm.js';
import { BusinessError } from './errors.js';
import { getSeller } from './masterdata.js';
import { nextYearNumber, sepaText, validIbanFormat } from './purchasing.js';
import type { Deps } from './workflow.js';

/*
 * SEPA-Lastschrift (Basis-Lastschrift CORE bzw. Firmenlastschrift B2B) für Kunden mit Mandat.
 * Ablauf: Mandat erfassen → Einzug wählen (offene Rechnungen) → pain.008-Datei (archiviert, unveränderbar) → bei der
 * Bank hochladen → Sammelgutschrift im Kontoauszug zuordnen (bucht die Zahlungen) bzw. „eingezogen“ von Hand.
 * Jede Rechnung höchstens einmal im Einzug (DB-Index), nach Rücklastschrift wieder möglich.
 */

export interface Mandate {
  id: string;
  customer_id: string;
  mandate_ref: string;
  signed_on: string;
  account_holder: string;
  iban: string;
  bic: string | null;
  scheme: 'CORE' | 'B2B';
  active: boolean;
  note: string | null;
  version: number;
}

const REF_OK = /^[A-Za-z0-9+?/\-:().,' ]{1,35}$/;
/** Gläubiger-ID: Land, Prüfziffern, ZZZ (Geschäftsbereich), nationale Kennung. Prüfziffer wie IBAN ohne Geschäftsbereich. */
export function validCreditorId(id: string): boolean {
  const s = id.replace(/\s/g, '').toUpperCase();
  const m = /^([A-Z]{2})(\d{2})([A-Z0-9]{3})([A-Z0-9]{1,28})$/.exec(s);
  if (!m) return false;
  const r = (m[4]! + m[1]! + m[2]!).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let mod = 0;
  for (const d of r) mod = (mod * 10 + Number(d)) % 97;
  return mod === 1;
}

export async function listMandates(sql: Sql, customerId?: string) {
  return sql<(Mandate & { customer_name: string; customer_no: string; used: boolean })[]>`
    select m.*, c.name as customer_name, c.customer_no,
           exists (select 1 from app.direct_debit_items d where d.mandate_id = m.id) as used
      from app.sepa_mandates m join app.customers c on c.id = m.customer_id
     where ${customerId ? sql`m.customer_id = ${customerId}` : sql`true`}
     order by m.active desc, c.name`;
}

export async function saveMandate(
  sql: Sql,
  id: string,
  p: {
    customerId: string;
    mandateRef: string;
    signedOn: string;
    accountHolder: string;
    iban: string;
    bic: string | null;
    scheme: 'CORE' | 'B2B';
    active: boolean;
    note: string | null;
    expectedVersion: number | null;
  },
  actor: string,
) {
  const ibanClean = p.iban.replace(/\s/g, '').toUpperCase();
  if (!validIbanFormat(ibanClean)) throw new BusinessError('IBAN ungültig (Prüfziffer)');
  if (!REF_OK.test(p.mandateRef.trim())) {
    throw new BusinessError("Mandatsreferenz: 1–35 Zeichen, nur Buchstaben, Ziffern und + ? / - : ( ) . , '");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.signedOn) || p.signedOn > todayBerlin()) {
    throw new BusinessError('Datum der Unterschrift ungültig (nicht in der Zukunft)');
  }
  if (!p.accountHolder.trim()) throw new BusinessError('Kontoinhaber fehlt');
  if (p.bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(p.bic.toUpperCase()))
    throw new BusinessError('BIC ungültig');
  await sql
    .begin(async (tx) => {
      const [cur] = await tx<{ version: number; used: boolean; mandate_ref: string; iban: string }[]>`
      select version, mandate_ref, iban,
             exists (select 1 from app.direct_debit_items d where d.mandate_id = m.id) as used
        from app.sepa_mandates m where id = ${id} for update`;
      assertVersion(cur?.version, p.expectedVersion, 'Das Mandat');
      // Mandatsreferenz/Konto nach erstem Einzug nicht mehr ändern → neues Mandat (bzw. Änderung anzeigen, später)
      if (cur?.used && (cur.mandate_ref !== p.mandateRef.trim() || cur.iban !== ibanClean)) {
        throw new BusinessError(
          'Mandat wurde schon verwendet – Referenz/IBAN nicht änderbar. Bitte neues Mandat anlegen.',
        );
      }
      if (p.active) {
        await tx`update app.sepa_mandates set active = false where customer_id = ${p.customerId} and id <> ${id} and active`;
      }
      const row = {
        customer_id: p.customerId,
        mandate_ref: p.mandateRef.trim(),
        signed_on: p.signedOn,
        account_holder: p.accountHolder.trim(),
        iban: ibanClean,
        bic: p.bic?.toUpperCase() || null,
        scheme: p.scheme,
        active: p.active,
        note: p.note,
      };
      if (cur) await tx`update app.sepa_mandates set ${tx(row as Record<string, unknown>)} where id = ${id}`;
      else
        await tx`insert into app.sepa_mandates ${tx({ id, created_by: actor, ...row } as Record<string, unknown>)}`;
      await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'save', 'sepa_mandate', ${id}, ${tx.json({ customer_id: p.customerId, ref: row.mandate_ref, active: p.active })})`;
    })
    .catch((e: unknown) => {
      if ((e as { code?: string }).code === '23505')
        throw new BusinessError('Mandatsreferenz ist schon vergeben');
      throw e;
    });
}

/** Nächster möglicher Fälligkeitstag: frühestens morgen (Einreichung bis D-1), nur Bankarbeitstage (TARGET2). */
export function earliestCollectionDate(today = todayBerlin()): string {
  let d = addDays(today, 1);
  const target2Closed = (x: string) =>
    isoWeekday(x) >= 6 ||
    /-(01-01|05-01|12-25|12-26)$/.test(x) ||
    ['Karfreitag', 'Ostermontag'].includes(holidayName(x) ?? '');
  while (target2Closed(d)) d = addDays(d, 1);
  return d;
}

export interface DebitCandidate {
  invoice_id: string;
  number: string;
  customer_id: string;
  customer_name: string;
  due_date: string;
  open_cents: bigint;
  mandate_id: string;
  mandate_ref: string;
  scheme: string;
}

/** Offene Rechnungen von Kunden mit aktivem Mandat, die nicht schon in einem Einzug stecken. */
export async function debitProposal(sql: Sql) {
  return sql<DebitCandidate[]>`
    select o.invoice_id, o.number, o.customer_id, c.name as customer_name, o.due_date, o.open_cents,
           m.id as mandate_id, m.mandate_ref, m.scheme
      from app.open_items o join app.customers c on c.id = o.customer_id
      join app.sepa_mandates m on m.customer_id = o.customer_id and m.active
     where o.open_cents > 0
       and not exists (select 1 from app.direct_debit_items d where d.invoice_id = o.invoice_id and d.returned_at is null)
     order by o.due_date, c.name`;
}

export function buildPain008(p: {
  messageId: string;
  createdAt: Date;
  collectionDate: string;
  creditorName: string;
  creditorIban: string;
  creditorBic: string;
  creditorId: string;
  items: {
    endToEnd: string;
    amount: bigint;
    mandateRef: string;
    signedOn: string;
    sequence: 'FRST' | 'RCUR';
    scheme: 'CORE' | 'B2B';
    debtorName: string;
    debtorIban: string;
    debtorBic: string | null;
    remittance: string;
  }[];
}): string {
  const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const amt = (c: bigint) => toXmlDecimal(c as Cents);
  const total = p.items.reduce((s, i) => s + i.amount, 0n);
  const groups = new Map<string, typeof p.items>();
  for (const i of p.items)
    groups.set(`${i.scheme}-${i.sequence}`, [...(groups.get(`${i.scheme}-${i.sequence}`) ?? []), i]);
  const pmtInf = [...groups.entries()]
    .map(([key, items], gi) => {
      const [scheme, seq] = key.split('-') as [string, string];
      const sum = items.reduce((s, i) => s + i.amount, 0n);
      const tx = items
        .map(
          (i) => `      <DrctDbtTxInf>
        <PmtId><EndToEndId>${x(i.endToEnd)}</EndToEndId></PmtId>
        <InstdAmt Ccy="EUR">${amt(i.amount)}</InstdAmt>
        <DrctDbtTx><MndtRltdInf><MndtId>${x(i.mandateRef)}</MndtId><DtOfSgntr>${i.signedOn}</DtOfSgntr></MndtRltdInf></DrctDbtTx>
        <DbtrAgt><FinInstnId>${i.debtorBic ? `<BICFI>${x(i.debtorBic)}</BICFI>` : '<Othr><Id>NOTPROVIDED</Id></Othr>'}</FinInstnId></DbtrAgt>
        <Dbtr><Nm>${x(sepaText(i.debtorName, 70))}</Nm></Dbtr>
        <DbtrAcct><Id><IBAN>${x(i.debtorIban)}</IBAN></Id></DbtrAcct>
        <RmtInf><Ustrd>${x(sepaText(i.remittance, 140))}</Ustrd></RmtInf>
      </DrctDbtTxInf>`,
        )
        .join('\n');
      return `    <PmtInf>
      <PmtInfId>${x(`${p.messageId}-${gi + 1}`.slice(0, 35))}</PmtInfId>
      <PmtMtd>DD</PmtMtd>
      <BtchBookg>true</BtchBookg>
      <NbOfTxs>${items.length}</NbOfTxs>
      <CtrlSum>${amt(sum)}</CtrlSum>
      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl><LclInstrm><Cd>${scheme}</Cd></LclInstrm><SeqTp>${seq}</SeqTp></PmtTpInf>
      <ReqdColltnDt>${p.collectionDate}</ReqdColltnDt>
      <Cdtr><Nm>${x(sepaText(p.creditorName, 70))}</Nm></Cdtr>
      <CdtrAcct><Id><IBAN>${x(p.creditorIban)}</IBAN></Id></CdtrAcct>
      <CdtrAgt><FinInstnId><BICFI>${x(p.creditorBic)}</BICFI></FinInstnId></CdtrAgt>
      <ChrgBr>SLEV</ChrgBr>
      <CdtrSchmeId><Id><PrvtId><Othr><Id>${x(p.creditorId)}</Id><SchmeNm><Prtry>SEPA</Prtry></SchmeNm></Othr></PrvtId></Id></CdtrSchmeId>
${tx}
    </PmtInf>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.08" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CstmrDrctDbtInitn>
    <GrpHdr>
      <MsgId>${x(p.messageId)}</MsgId>
      <CreDtTm>${p.createdAt.toISOString().slice(0, 19)}</CreDtTm>
      <NbOfTxs>${p.items.length}</NbOfTxs>
      <CtrlSum>${amt(total)}</CtrlSum>
      <InitgPty><Nm>${x(sepaText(p.creditorName, 70))}</Nm></InitgPty>
    </GrpHdr>
${pmtInf}
  </CstmrDrctDbtInitn>
</Document>
`;
}

/**
 * Einzug anlegen: Datei erzeugen und archivieren. Feste ID → doppelter Klick erzeugt keinen zweiten Einzug;
 * jede Rechnung nur einmal (Unique-Index). Erstlastschrift (FRST), wenn das Mandat noch nie eingezogen wurde.
 */
export async function createDebitRun(
  deps: Deps,
  p: { id: string; invoiceIds: string[]; collectionDate: string; creditorIban: string; actor: string },
) {
  const { sql } = deps;
  const [exists] = await sql`select 1 from app.direct_debit_runs where id = ${p.id}`;
  if (exists) return p.id;
  if (!p.invoiceIds.length) throw new BusinessError('Bitte mindestens eine Rechnung auswählen');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.collectionDate) || p.collectionDate < earliestCollectionDate()) {
    throw new BusinessError(
      `Fälligkeit frühestens ${formatDateDe(earliestCollectionDate())} (Bankarbeitstag)`,
    );
  }
  const [co] = await sql<{ creditor_id: string | null }[]>`select creditor_id from app.company`;
  if (!co?.creditor_id || !validCreditorId(co.creditor_id)) {
    throw new BusinessError(
      'Gläubiger-Identifikationsnummer fehlt oder ist ungültig (Einstellungen → Firma)',
    );
  }
  const seller = await getSeller(sql);
  const acct = seller.bankAccounts.find(
    (b) => b.iban.replace(/\s/g, '') === p.creditorIban.replace(/\s/g, ''),
  );
  if (!acct) throw new BusinessError('Konto unbekannt');
  const cands = (await debitProposal(sql)).filter((c) => p.invoiceIds.includes(c.invoice_id));
  if (cands.length !== new Set(p.invoiceIds).size) {
    throw new BusinessError('Mindestens eine Rechnung ist nicht (mehr) einziehbar – bitte neu laden');
  }
  // Vorabankündigung auf der Rechnung nennt den Fälligkeitstag → nicht früher einziehen
  const early = cands.filter((c) => c.due_date > p.collectionDate);
  if (early.length) {
    throw new BusinessError(
      `Einzug vor Fälligkeit nicht erlaubt (angekündigt): ${early.map((c) => `${c.number} fällig ${formatDateDe(c.due_date)}`).join(', ')}`,
    );
  }
  const year = p.collectionDate.slice(0, 4);
  let number = '';
  await sql
    .begin(async (tx) => {
      number = await nextYearNumber(tx, 'direct_debit', 'LS-', year, 3);
      const messageId = `VD-${number}-${p.id.slice(0, 8)}`.slice(0, 35);
      const total = cands.reduce((s, c) => s + c.open_cents, 0n);
      await tx`insert into app.direct_debit_runs (id, number, collection_date, creditor_iban, creditor_bic, creditor_id, total_cents,
                                                 item_count, message_id, created_by)
             values (${p.id}, ${number}, ${p.collectionDate}, ${acct.iban.replace(/\s/g, '')}, ${acct.bic},
                     ${co.creditor_id!.replace(/\s/g, '').toUpperCase()}, ${total}, ${cands.length}, ${messageId}, ${p.actor})`;
      for (const c of cands) {
        const [used] =
          await tx`select 1 from app.direct_debit_items where mandate_id = ${c.mandate_id} and run_id <> ${p.id} and returned_at is null`;
        const e2e = `VD${createHash('md5').update(`${p.id}:${c.invoice_id}`).digest('hex').slice(0, 30)}`;
        await tx`insert into app.direct_debit_items (run_id, invoice_id, mandate_id, amount_cents, sequence_type, end_to_end_id, remittance)
               values (${p.id}, ${c.invoice_id}, ${c.mandate_id}, ${c.open_cents}, ${used ? 'RCUR' : 'FRST'}, ${e2e},
                       ${`Rechnung ${c.number} Kunde ${c.customer_name}`})`;
      }
      await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${p.actor}, 'create', 'direct_debit_run', ${p.id}, ${tx.json({ number, items: cands.length, total: String(total) })})`;
    })
    .catch((e: unknown) => {
      if ((e as { code?: string }).code === '23505') {
        throw new BusinessError('Eine Rechnung steckt schon in einem anderen Einzug – bitte neu laden');
      }
      throw e;
    });
  const xml = await debitRunXml(sql, p.id);
  const path = `lastschriften/${year}/${p.id}.xml`;
  const { sha256 } = await deps.archive.put(path, new TextEncoder().encode(xml));
  await sql`update app.direct_debit_runs set xml_path = ${path}, xml_sha256 = ${sha256} where id = ${p.id} and xml_path is null`;
  return p.id;
}

export async function debitRunXml(sql: Sql, id: string): Promise<string> {
  const [run] = await sql<
    {
      message_id: string;
      created_at: Date;
      collection_date: string;
      creditor_iban: string;
      creditor_bic: string;
      creditor_id: string;
    }[]
  >`select message_id, created_at, collection_date, creditor_iban, creditor_bic, creditor_id from app.direct_debit_runs where id = ${id}`;
  if (!run) throw new BusinessError('Einzug nicht gefunden');
  const items = await sql<
    {
      end_to_end_id: string;
      amount_cents: bigint;
      sequence_type: 'FRST' | 'RCUR';
      remittance: string;
      mandate_ref: string;
      signed_on: string;
      scheme: 'CORE' | 'B2B';
      account_holder: string;
      iban: string;
      bic: string | null;
    }[]
  >`
    select d.end_to_end_id, d.amount_cents, d.sequence_type, d.remittance, m.mandate_ref, m.signed_on, m.scheme,
           m.account_holder, m.iban, m.bic
      from app.direct_debit_items d join app.sepa_mandates m on m.id = d.mandate_id
     where d.run_id = ${id} order by m.account_holder, d.end_to_end_id`;
  const seller = await getSeller(sql);
  return buildPain008({
    messageId: run.message_id,
    createdAt: run.created_at,
    collectionDate: run.collection_date,
    creditorName: seller.legalName,
    creditorIban: run.creditor_iban,
    creditorBic: run.creditor_bic,
    creditorId: run.creditor_id,
    items: items.map((i) => ({
      endToEnd: i.end_to_end_id,
      amount: i.amount_cents,
      mandateRef: i.mandate_ref,
      signedOn: i.signed_on,
      sequence: i.sequence_type,
      scheme: i.scheme,
      debtorName: i.account_holder,
      debtorIban: i.iban,
      debtorBic: i.bic,
      remittance: i.remittance,
    })),
  });
}

export async function listDebitRuns(sql: Sql) {
  return sql<
    {
      id: string;
      number: string;
      collection_date: string;
      total_cents: bigint;
      item_count: number;
      status: string;
      created_by: string;
      created_at: Date;
      xml_sha256: string | null;
    }[]
  >`select id, number, collection_date, total_cents, item_count, status, created_by, created_at, xml_sha256
      from app.direct_debit_runs order by created_at desc`;
}

export async function debitRunItems(sql: Sql, id: string) {
  return sql<
    {
      invoice_id: string;
      number: string;
      customer_name: string;
      amount_cents: bigint;
      sequence_type: string;
      mandate_ref: string;
      returned_at: string | null;
      return_reason: string | null;
    }[]
  >`
    select d.invoice_id, i.number, c.name as customer_name, d.amount_cents, d.sequence_type, m.mandate_ref,
           d.returned_at, d.return_reason
      from app.direct_debit_items d join app.invoices i on i.id = d.invoice_id
      join app.customers c on c.id = i.customer_id join app.sepa_mandates m on m.id = d.mandate_id
     where d.run_id = ${id} order by c.name, i.number`;
}

/** Einzug ohne Kontoauszug als eingegangen buchen (Datum der Gutschrift). */
export async function settleDebitRun(sql: Sql, id: string, paidOn: string, actor: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || paidOn > todayBerlin())
    throw new BusinessError('Datum der Gutschrift ungültig');
  await sql.begin((tx) => settleDebitRunTx(tx, id, paidOn, actor, null));
}
