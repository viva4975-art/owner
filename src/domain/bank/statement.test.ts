import { describe, expect, it } from 'vitest';
import { invoiceNumbersIn, parseAmount, parseBankCsv, parseCamt053, parseDate } from './statement.js';

const CAMT = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>X</MsgId><CreDtTm>2026-10-05T06:00:00</CreDtTm></GrpHdr>
    <Stmt>
      <Id>1</Id>
      <Acct><Id><IBAN>DE39701900000003297837</IBAN></Id></Acct>
      <Ntry>
        <Amt Ccy="EUR">5770.15</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>
        <BookgDt><Dt>2026-10-02</Dt></BookgDt><ValDt><Dt>2026-10-02</Dt></ValDt>
        <AcctSvcrRef>2026100200001</AcctSvcrRef>
        <NtryDtls><TxDtls>
          <Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs>
          <RltdPties><Dbtr><Pty><Nm>Landeshauptstadt München</Nm></Pty></Dbtr><DbtrAcct><Id><IBAN>DE02700500000000000001</IBAN></Id></DbtrAcct></RltdPties>
          <RmtInf><Ustrd>RE 1038301 Kassenzeichen 4711</Ustrd><Ustrd>Unterhaltsreinigung</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">120.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>
        <BookgDt><Dt>2026-10-03</Dt></BookgDt>
        <NtryDtls><TxDtls>
          <Refs><EndToEndId>E2E-1</EndToEndId></Refs>
          <RltdPties><Cdtr><Nm>Reinigungsbedarf GmbH</Nm></Cdtr></RltdPties>
          <RmtInf><Ustrd>Rechnung 77</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">1.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>PDNG</Cd></Sts>
        <BookgDt><Dt>2026-10-04</Dt></BookgDt>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

describe('Kontoauszug', () => {
  it('Beträge und Daten', () => {
    expect(parseAmount('1.234,56')).toBe(123456n);
    expect(parseAmount('-1.234,5')).toBe(-123450n);
    expect(parseAmount('1234.56')).toBe(123456n);
    expect(parseAmount('12,00 €')).toBe(1200n);
    expect(() => parseAmount('abc')).toThrow();
    expect(parseDate('02.10.26')).toBe('2026-10-02');
    expect(parseDate('2026-10-02T10:00:00')).toBe('2026-10-02');
  });

  it('CAMT.053: Gutschrift, Lastschrift, vorgemerkte ignoriert', () => {
    const l = parseCamt053(CAMT);
    expect(l).toHaveLength(2);
    expect(l[0]).toMatchObject({
      accountIban: 'DE39701900000003297837',
      bookingDate: '2026-10-02',
      amountCents: 577015n,
      counterpartyName: 'Landeshauptstadt München',
      counterpartyIban: 'DE02700500000000000001',
      purpose: 'RE 1038301 Kassenzeichen 4711 Unterhaltsreinigung',
      endToEndId: null,
      bankRef: '2026100200001',
    });
    expect(l[1]).toMatchObject({
      amountCents: -12000n,
      counterpartyName: 'Reinigungsbedarf GmbH',
      endToEndId: 'E2E-1',
    });
  });

  it('CAMT mit DTD wird abgelehnt (XXE)', () => {
    expect(() => parseCamt053('<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><Document/>')).toThrow(
      /DTD/,
    );
  });

  it('CSV (Sparkasse-Format) mit Kopfzeilen davor', () => {
    const csv = [
      'Umsätze Girokonto;',
      '',
      '"Auftragskonto";"Buchungstag";"Valutadatum";"Buchungstext";"Verwendungszweck";"Beguenstigter/Zahlungspflichtiger";"Kontonummer/IBAN";"BIC (SWIFT-Code)";"Betrag";"Waehrung"',
      '"DE39701900000003297837";"02.10.26";"02.10.26";"GUTSCHR. UEBERWEISUNG";"Rechnung 1038301; Danke";"Muster ""GmbH""";"DE02700500000000000001";"X";"5.770,15";"EUR"',
      '"DE39701900000003297837";"03.10.26";"03.10.26";"LASTSCHRIFT";"Strom";"Stadtwerke";"";"";"-80,00";"EUR"',
    ].join('\r\n');
    const l = parseBankCsv(csv);
    expect(l).toHaveLength(2);
    expect(l[0]).toMatchObject({
      accountIban: 'DE39701900000003297837',
      bookingDate: '2026-10-02',
      amountCents: 577015n,
      counterpartyName: 'Muster "GmbH"',
      purpose: 'Rechnung 1038301; Danke',
    });
    expect(l[1]!.amountCents).toBe(-8000n);
  });

  it('Rechnungsnummern im Verwendungszweck', () => {
    const known = (n: string) => ['1038301', '1038302', 'RE-2026-00012'].includes(n);
    expect(invoiceNumbersIn('RE 1038301 und 1038302, Kd 29901', known)).toEqual(['1038301', '1038302']);
    expect(invoiceNumbersIn('re-2026-00012', known)).toEqual(['RE-2026-00012']);
    expect(invoiceNumbersIn('Kassenzeichen 10383011', known)).toEqual([]);
  });
});
