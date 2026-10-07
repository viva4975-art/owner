/**
 * App für Objektleitung/Büro, Erweiterung Runde 23 (Ahmed: „App für Objektleiter umfangreicher – Schlüssel,
 * Unterweisungen usw. ausfüllen, Personalstammdatenblatt in jeder Sprache für die Mitarbeiter, Objektordner,
 * Einsätze, Zeiten, Auftrag für Sub erstellen – muss im Büro freigegeben werden“).
 *
 * - Personalbogen zum Selbstausfüllen am Handy der Objektleitung in der Sprache der neuen Kraft (7 Sprachen, deutsche
 *   Bezeichnung klein darunter). Absenden legt den Bogen fürs Büro ab; die Objektleitung kann ihn danach nicht mehr
 *   lesen (vertraulich: Steuer-ID, SV-Nr., IBAN – RLS nur Admin/Personal).
 * - NU-Auftrag anfragen: Entwurf mit „angefragt von“, das Büro prüft (Nachweise, Preis) und erteilt.
 */
import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import { BusinessError } from '../services/errors.js';
import { BILLING, FREQUENCY, saveSubcontract } from '../services/subcontractors.js';
import { type AppEnv, type Ctx, UUID, assertSite } from './app.js';
import { str } from './forms.js';
import { PageHead, dateDe } from './layout.js';
import { Ic } from './m/routes-mobile.js';
import { QmLayout } from './routes-qm.js';
import { SiteOptions } from './site-options.js';

type Lang = 'de' | 'en' | 'ro' | 'tr' | 'pl' | 'hr' | 'bg';
export const BOGEN_LANGS: [Lang, string][] = [
  ['de', 'Deutsch'],
  ['en', 'English'],
  ['ro', 'Română'],
  ['tr', 'Türkçe'],
  ['pl', 'Polski'],
  ['hr', 'Hrvatski / Bosanski / Srpski'],
  ['bg', 'Български'],
];

/** Felder des Personalbogens (Schlüssel = Feldnamen der Mitarbeiter-Stammdaten → Übernahme ins Formular). */
export const BOGEN_FIELDS: { key: string; type?: 'date' | 'email' | 'tel' | 'select'; required?: boolean }[] =
  [
    { key: 'salutation', type: 'select' },
    { key: 'first_name', required: true },
    { key: 'last_name', required: true },
    { key: 'birth_date', type: 'date', required: true },
    { key: 'birth_place' },
    { key: 'birth_country' },
    { key: 'nationality', required: true },
    { key: 'marital_status', type: 'select' },
    { key: 'street', required: true },
    { key: 'postal_code', required: true },
    { key: 'city', required: true },
    { key: 'mobile', type: 'tel', required: true },
    { key: 'email_private', type: 'email' },
    { key: 'iban' },
    { key: 'tax_id' },
    { key: 'social_security_no' },
    { key: 'health_insurance' },
    { key: 'residence_permit_until', type: 'date' },
    { key: 'work_permit_until', type: 'date' },
    { key: 'languages' },
    { key: 'emergency_contact' },
    { key: 'notes' },
  ];

const DE: Record<string, string> = {
  title: 'Personalbogen',
  intro: 'Bitte füllen Sie Ihre Angaben aus. Felder mit * sind Pflicht.',
  salutation: 'Anrede',
  first_name: 'Vorname',
  last_name: 'Nachname',
  birth_date: 'Geburtsdatum',
  birth_place: 'Geburtsort',
  birth_country: 'Geburtsland',
  nationality: 'Staatsangehörigkeit',
  marital_status: 'Familienstand',
  street: 'Straße und Hausnummer',
  postal_code: 'PLZ',
  city: 'Ort',
  mobile: 'Handynummer',
  email_private: 'E-Mail',
  iban: 'IBAN (Bankkonto für den Lohn)',
  tax_id: 'Steuer-ID (11 Ziffern)',
  social_security_no: 'Sozialversicherungsnummer',
  health_insurance: 'Krankenkasse',
  residence_permit_until: 'Aufenthaltstitel gültig bis',
  work_permit_until: 'Arbeitserlaubnis gültig bis',
  languages: 'Sprachen',
  emergency_contact: 'Notfallkontakt (Name, Telefon)',
  notes: 'Bemerkungen',
  herr: 'Herr',
  frau: 'Frau',
  divers: 'divers',
  ledig: 'ledig',
  verheiratet: 'verheiratet',
  geschieden: 'geschieden',
  verwitwet: 'verwitwet',
  privacy:
    'Ihre Angaben werden nur für das Arbeitsverhältnis verwendet (Lohnabrechnung, Sozialversicherung) und vertraulich behandelt.',
  confirm: 'Ich bestätige, dass meine Angaben richtig sind.',
  send: 'Absenden',
  thanks: 'Danke! Ihre Angaben wurden an das Büro übermittelt.',
  choose: 'Sprache wählen',
};
const T: Record<Exclude<Lang, 'de'>, Record<string, string>> = {
  en: {
    title: 'Personnel form',
    intro: 'Please fill in your details. Fields marked * are required.',
    salutation: 'Title',
    first_name: 'First name',
    last_name: 'Last name',
    birth_date: 'Date of birth',
    birth_place: 'Place of birth',
    birth_country: 'Country of birth',
    nationality: 'Nationality',
    marital_status: 'Marital status',
    street: 'Street and house number',
    postal_code: 'Postcode',
    city: 'City',
    mobile: 'Mobile number',
    email_private: 'E-mail',
    iban: 'IBAN (bank account for your wages)',
    tax_id: 'Tax ID (11 digits)',
    social_security_no: 'Social security number',
    health_insurance: 'Health insurance',
    residence_permit_until: 'Residence permit valid until',
    work_permit_until: 'Work permit valid until',
    languages: 'Languages',
    emergency_contact: 'Emergency contact (name, phone)',
    notes: 'Remarks',
    herr: 'Mr',
    frau: 'Ms',
    divers: 'diverse',
    ledig: 'single',
    verheiratet: 'married',
    geschieden: 'divorced',
    verwitwet: 'widowed',
    privacy:
      'Your data is used only for your employment (payroll, social insurance) and treated confidentially.',
    confirm: 'I confirm that my details are correct.',
    send: 'Send',
    thanks: 'Thank you! Your details have been sent to the office.',
    choose: 'Choose language',
  },
  ro: {
    title: 'Fișă de personal',
    intro: 'Vă rugăm să completați datele. Câmpurile cu * sunt obligatorii.',
    salutation: 'Formula de adresare',
    first_name: 'Prenume',
    last_name: 'Nume',
    birth_date: 'Data nașterii',
    birth_place: 'Locul nașterii',
    birth_country: 'Țara nașterii',
    nationality: 'Cetățenie',
    marital_status: 'Stare civilă',
    street: 'Strada și numărul',
    postal_code: 'Cod poștal',
    city: 'Localitate',
    mobile: 'Număr de telefon mobil',
    email_private: 'E-mail',
    iban: 'IBAN (cont bancar pentru salariu)',
    tax_id: 'Cod fiscal german (11 cifre)',
    social_security_no: 'Număr de asigurare socială',
    health_insurance: 'Casa de asigurări de sănătate',
    residence_permit_until: 'Permis de ședere valabil până la',
    work_permit_until: 'Permis de muncă valabil până la',
    languages: 'Limbi',
    emergency_contact: 'Contact în caz de urgență (nume, telefon)',
    notes: 'Observații',
    herr: 'Domnul',
    frau: 'Doamna',
    divers: 'divers',
    ledig: 'necăsătorit(ă)',
    verheiratet: 'căsătorit(ă)',
    geschieden: 'divorțat(ă)',
    verwitwet: 'văduv(ă)',
    privacy:
      'Datele dumneavoastră sunt folosite doar pentru raportul de muncă (salariu, asigurări sociale) și sunt tratate confidențial.',
    confirm: 'Confirm că datele mele sunt corecte.',
    send: 'Trimite',
    thanks: 'Mulțumim! Datele au fost trimise la birou.',
    choose: 'Alegeți limba',
  },
  tr: {
    title: 'Personel formu',
    intro: 'Lütfen bilgilerinizi doldurun. * işaretli alanlar zorunludur.',
    salutation: 'Hitap',
    first_name: 'Ad',
    last_name: 'Soyad',
    birth_date: 'Doğum tarihi',
    birth_place: 'Doğum yeri',
    birth_country: 'Doğum ülkesi',
    nationality: 'Uyruk',
    marital_status: 'Medeni durum',
    street: 'Sokak ve kapı numarası',
    postal_code: 'Posta kodu',
    city: 'Şehir',
    mobile: 'Cep telefonu',
    email_private: 'E-posta',
    iban: 'IBAN (maaş için banka hesabı)',
    tax_id: 'Vergi kimlik numarası (11 haneli)',
    social_security_no: 'Sosyal sigorta numarası',
    health_insurance: 'Sağlık sigortası',
    residence_permit_until: 'Oturum izni geçerlilik tarihi',
    work_permit_until: 'Çalışma izni geçerlilik tarihi',
    languages: 'Diller',
    emergency_contact: 'Acil durumda aranacak kişi (ad, telefon)',
    notes: 'Notlar',
    herr: 'Bay',
    frau: 'Bayan',
    divers: 'diğer',
    ledig: 'bekâr',
    verheiratet: 'evli',
    geschieden: 'boşanmış',
    verwitwet: 'dul',
    privacy: 'Bilgileriniz yalnızca iş ilişkisi için (bordro, sosyal sigorta) kullanılır ve gizli tutulur.',
    confirm: 'Bilgilerimin doğru olduğunu onaylıyorum.',
    send: 'Gönder',
    thanks: 'Teşekkürler! Bilgileriniz ofise iletildi.',
    choose: 'Dil seçin',
  },
  pl: {
    title: 'Kwestionariusz osobowy',
    intro: 'Prosimy o uzupełnienie danych. Pola oznaczone * są obowiązkowe.',
    salutation: 'Zwrot grzecznościowy',
    first_name: 'Imię',
    last_name: 'Nazwisko',
    birth_date: 'Data urodzenia',
    birth_place: 'Miejsce urodzenia',
    birth_country: 'Kraj urodzenia',
    nationality: 'Obywatelstwo',
    marital_status: 'Stan cywilny',
    street: 'Ulica i numer domu',
    postal_code: 'Kod pocztowy',
    city: 'Miejscowość',
    mobile: 'Numer telefonu komórkowego',
    email_private: 'E-mail',
    iban: 'IBAN (konto do wypłaty wynagrodzenia)',
    tax_id: 'Niemiecki numer identyfikacji podatkowej (11 cyfr)',
    social_security_no: 'Numer ubezpieczenia społecznego',
    health_insurance: 'Kasa chorych',
    residence_permit_until: 'Zezwolenie na pobyt ważne do',
    work_permit_until: 'Zezwolenie na pracę ważne do',
    languages: 'Języki',
    emergency_contact: 'Kontakt w nagłych wypadkach (imię, telefon)',
    notes: 'Uwagi',
    herr: 'Pan',
    frau: 'Pani',
    divers: 'inna',
    ledig: 'stanu wolnego',
    verheiratet: 'żonaty/zamężna',
    geschieden: 'rozwiedziony/a',
    verwitwet: 'wdowiec/wdowa',
    privacy:
      'Dane są wykorzystywane wyłącznie na potrzeby stosunku pracy (wynagrodzenie, ubezpieczenia) i traktowane poufnie.',
    confirm: 'Potwierdzam, że moje dane są prawidłowe.',
    send: 'Wyślij',
    thanks: 'Dziękujemy! Dane zostały przekazane do biura.',
    choose: 'Wybierz język',
  },
  hr: {
    title: 'Upitnik za zaposlenike',
    intro: 'Molimo ispunite svoje podatke. Polja sa * su obavezna.',
    salutation: 'Oslovljavanje',
    first_name: 'Ime',
    last_name: 'Prezime',
    birth_date: 'Datum rođenja',
    birth_place: 'Mjesto rođenja',
    birth_country: 'Država rođenja',
    nationality: 'Državljanstvo',
    marital_status: 'Bračno stanje',
    street: 'Ulica i kućni broj',
    postal_code: 'Poštanski broj',
    city: 'Mjesto',
    mobile: 'Broj mobitela',
    email_private: 'E-mail',
    iban: 'IBAN (bankovni račun za plaću)',
    tax_id: 'Njemački porezni broj (11 znamenki)',
    social_security_no: 'Broj socijalnog osiguranja',
    health_insurance: 'Zdravstveno osiguranje',
    residence_permit_until: 'Boravišna dozvola vrijedi do',
    work_permit_until: 'Radna dozvola vrijedi do',
    languages: 'Jezici',
    emergency_contact: 'Kontakt u hitnom slučaju (ime, telefon)',
    notes: 'Napomene',
    herr: 'Gospodin',
    frau: 'Gospođa',
    divers: 'ostalo',
    ledig: 'neoženjen/neudana',
    verheiratet: 'oženjen/udana',
    geschieden: 'razveden/a',
    verwitwet: 'udovac/udovica',
    privacy:
      'Vaši podaci koriste se samo za radni odnos (obračun plaće, socijalno osiguranje) i tretiraju se povjerljivo.',
    confirm: 'Potvrđujem da su moji podaci točni.',
    send: 'Pošalji',
    thanks: 'Hvala! Vaši podaci poslani su u ured.',
    choose: 'Odaberite jezik',
  },
  bg: {
    title: 'Лична карта на служителя',
    intro: 'Моля, попълнете данните си. Полетата със * са задължителни.',
    salutation: 'Обръщение',
    first_name: 'Име',
    last_name: 'Фамилия',
    birth_date: 'Дата на раждане',
    birth_place: 'Място на раждане',
    birth_country: 'Държава на раждане',
    nationality: 'Гражданство',
    marital_status: 'Семейно положение',
    street: 'Улица и номер',
    postal_code: 'Пощенски код',
    city: 'Град',
    mobile: 'Мобилен телефон',
    email_private: 'Имейл',
    iban: 'IBAN (банкова сметка за заплатата)',
    tax_id: 'Германски данъчен номер (11 цифри)',
    social_security_no: 'Номер на социалната осигуровка',
    health_insurance: 'Здравна каса',
    residence_permit_until: 'Разрешение за пребиваване валидно до',
    work_permit_until: 'Разрешение за работа валидно до',
    languages: 'Езици',
    emergency_contact: 'Контакт при спешност (име, телефон)',
    notes: 'Бележки',
    herr: 'Господин',
    frau: 'Госпожа',
    divers: 'друго',
    ledig: 'неженен/неомъжена',
    verheiratet: 'женен/омъжена',
    geschieden: 'разведен/а',
    verwitwet: 'вдовец/вдовица',
    privacy:
      'Данните Ви се използват само за трудовото правоотношение (заплата, осигуровки) и се третират поверително.',
    confirm: 'Потвърждавам, че данните ми са верни.',
    send: 'Изпрати',
    thanks: 'Благодарим! Данните Ви бяха изпратени в офиса.',
    choose: 'Изберете език',
  },
};
const tr = (lang: Lang, k: string) => (lang === 'de' ? DE[k] : (T[lang][k] ?? DE[k])) ?? k;

export function registerOlAppRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;
  const render = (c: Context<AppEnv>, title: string, body: Child) =>
    c.html(
      '<!doctype html>' +
        String(
          <QmLayout
            path={c.req.path}
            title={title}
            flash={{ ok: c.req.query('ok') ?? '', err: c.req.query('fehler') ?? '' }}
          >
            {body}
          </QmLayout>,
        ),
    );
  const Top = ({ title, href = '/qm' }: { title: string; href?: string }) => (
    <div class="qm-top">
      <a href={href} aria-label="zurück">
        <Ic n="back" />
      </a>
      <h1>{title}</h1>
      <span style="width:36px" />
    </div>
  );

  // ------------------------------------------------------------------ Personalbogen
  app.get('/qm/personalbogen', (c) =>
    render(
      c,
      'Personalbogen',
      <>
        <Top title="Personalbogen" />
        <p class="mut">
          Für neue Mitarbeitende: Sprache wählen und das Handy zum Ausfüllen übergeben. Die Angaben gehen
          vertraulich ans Büro (Personal) – Sie können sie danach nicht mehr sehen.
        </p>
        <div class="qm-btns" style="flex-direction:column">
          {BOGEN_LANGS.map(([k, l]) => (
            <a
              href={`/qm/personalbogen/${k}${c.req.query('objekt') ? `?objekt=${c.req.query('objekt')}` : ''}`}
            >
              <Ic n="doc" /> {l}
            </a>
          ))}
        </div>
      </>,
    ),
  );

  app.get('/qm/personalbogen/:lang{[a-z]{2}}', (c) => {
    const lang = (BOGEN_LANGS.find(([k]) => k === c.req.param('lang'))?.[0] ?? 'de') as Lang;
    const L = (k: string) => tr(lang, k);
    const objekt = c.req.query('objekt') ?? '';
    return render(
      c,
      L('title'),
      <>
        <Top title={L('title')} href="/qm/personalbogen" />
        <p class="mut">{L('intro')}</p>
        <form method="post" action="/qm/personalbogen" class="bogen" lang={lang}>
          <input type="hidden" name="id" value={randomUUID()} />
          <input type="hidden" name="lang" value={lang} />
          <input type="hidden" name="objekt" value={objekt} />
          {BOGEN_FIELDS.map((f) => (
            <label class="bf">
              <span>
                {L(f.key)}
                {f.required ? ' *' : ''}
                {lang !== 'de' && <small>{DE[f.key]}</small>}
              </span>
              {f.key === 'salutation' ? (
                <select name={f.key}>
                  <option value="" />
                  <option value="Herr">{L('herr')}</option>
                  <option value="Frau">{L('frau')}</option>
                  <option value="divers">{L('divers')}</option>
                </select>
              ) : f.key === 'marital_status' ? (
                <select name={f.key}>
                  <option value="" />
                  {['ledig', 'verheiratet', 'geschieden', 'verwitwet'].map((k) => (
                    <option value={k}>{L(k)}</option>
                  ))}
                </select>
              ) : f.key === 'notes' || f.key === 'emergency_contact' ? (
                <textarea name={f.key} rows={2} />
              ) : (
                <input
                  name={f.key}
                  type={f.type ?? 'text'}
                  required={f.required}
                  autocomplete="off"
                  {...(f.key === 'postal_code' ? { inputmode: 'numeric' } : {})}
                />
              )}
            </label>
          ))}
          <p class="small mut">{L('privacy')}</p>
          <label class="bf chk">
            <input type="checkbox" name="confirm" value="1" required /> {L('confirm')}
          </label>
          <button class="btn-big">{L('send')}</button>
        </form>
        <style
          dangerouslySetInnerHTML={{
            __html:
              '.bogen{display:flex;flex-direction:column;gap:10px}.bf{display:flex;flex-direction:column;gap:4px;font-weight:600}.bf small{display:block;font-weight:400;color:#8a7a80;font-size:12px}.bf input,.bf select,.bf textarea{font:inherit;font-weight:400;padding:12px;border:1px solid #e3d6db;border-radius:10px;background:#fff}.bf.chk{flex-direction:row;align-items:center;gap:10px}.btn-big{font:inherit;font-weight:700;padding:14px;border:0;border-radius:12px;background:#7d1435;color:#fff}',
          }}
        />
      </>,
    );
  });

  app.post('/qm/personalbogen', async (c) => {
    const b = await c.req.parseBody();
    const id = typeof b.id === 'string' && /^[0-9a-f-]{36}$/.test(b.id) ? b.id : randomUUID();
    const lang = (BOGEN_LANGS.find(([k]) => k === b.lang)?.[0] ?? 'de') as Lang;
    if (b.confirm !== '1') throw new BusinessError(tr(lang, 'confirm'));
    const data: Record<string, string> = {};
    for (const f of BOGEN_FIELDS) {
      const v = typeof b[f.key] === 'string' ? (b[f.key] as string).trim().slice(0, 300) : '';
      if (f.required && !v) throw new BusinessError(`${tr(lang, f.key)} fehlt`);
      if (v) data[f.key] = v;
    }
    if (data.iban) data.iban = data.iban.replace(/\s+/g, '').toUpperCase();
    const site = typeof b.objekt === 'string' && /^[0-9a-f-]{36}$/.test(b.objekt) ? b.objekt : null;
    if (site) assertSite(c, site);
    await sql`insert into app.personnel_forms (id, lang, site_id, data, created_by)
              values (${id}, ${lang}, ${site}, ${sql.json(data)}, ${c.get('actor')})
              on conflict (id) do nothing`;
    await sql`insert into app.audit_log (actor, action, entity, entity_id)
              values (${c.get('actor')}, 'personnel_form', 'personnel_form', ${id})`;
    return render(
      c,
      tr(lang, 'title'),
      <>
        <Top title={tr(lang, 'title')} />
        <div class="qm-empty">
          <Ic n="party" />
          {tr(lang, 'thanks')}
          {lang !== 'de' && <div class="small">{DE.thanks}</div>}
        </div>
        <div class="qm-btns">
          <a href="/qm/personalbogen">
            <Ic n="doc" /> Nächster Personalbogen
          </a>
          <a href="/qm">
            <Ic n="home" /> Übersicht
          </a>
        </div>
      </>,
    );
  });

  // Büro: eingegangene Personalbögen (nur Personal/Admin)
  app.get('/personal/personalboegen', async (c) => {
    const rows = await sql<
      {
        id: string;
        lang: string;
        data: Record<string, string>;
        status: string;
        created_by: string;
        created_at: Date;
        site_name: string | null;
        employee_id: string | null;
      }[]
    >`select f.*, s.name as site_name from app.personnel_forms f left join app.sites s on s.id = f.site_id
       order by (f.status = 'neu') desc, f.created_at desc limit 300`;
    return page(
      c,
      'Personalbögen',
      'personal',
      <>
        <PageHead title="Personalbögen (aus der App)" crumbs={[['Personal', '/personal']]} />
        <p class="mut" style="margin-top:0">
          Von neuen Mitarbeitenden am Handy der Objektleitung ausgefüllt (in ihrer Sprache). „Als Mitarbeiter
          anlegen“ öffnet das Stammdatenformular vorausgefüllt; Beschäftigungsart, Vergütung und Eintritt
          ergänzt das Büro.
        </p>
        {rows.map((r) => (
          <details class="card" open={r.status === 'neu'}>
            <summary style="cursor:pointer">
              <b>
                {r.data.last_name}, {r.data.first_name}
              </b>{' '}
              <span class={`badge ${r.status === 'neu' ? 'warn' : r.status === 'uebernommen' ? 'ok' : ''}`}>
                {r.status === 'neu' ? 'neu' : r.status === 'uebernommen' ? 'übernommen' : 'verworfen'}
              </span>{' '}
              <span class="small mut">
                {r.created_at.toLocaleString('de-DE', {
                  timeZone: 'Europe/Berlin',
                  dateStyle: 'short',
                  timeStyle: 'short',
                })}{' '}
                · {r.created_by}
                {r.site_name ? ` · ${r.site_name}` : ''} · Sprache {r.lang}
              </span>
            </summary>
            <dl class="kv" style="margin-top:10px">
              {BOGEN_FIELDS.filter((f) => r.data[f.key]).map((f) => (
                <>
                  <dt>{DE[f.key]}</dt>
                  <dd>{f.type === 'date' ? dateDe(r.data[f.key]!) : r.data[f.key]}</dd>
                </>
              ))}
            </dl>
            {r.status === 'neu' && (
              <div class="actions">
                <a class="btn" href={`/personal/${randomUUID()}/bearbeiten?bogen=${r.id}`}>
                  Als Mitarbeiter anlegen
                </a>
                <form method="post" action={`/personal/personalboegen/${r.id}`}>
                  <button class="btn sec" name="status" value="uebernommen">
                    Erledigt (übernommen)
                  </button>
                </form>
                <form method="post" action={`/personal/personalboegen/${r.id}`}>
                  <button class="btn ghost" name="status" value="verworfen">
                    Verwerfen
                  </button>
                </form>
              </div>
            )}
          </details>
        ))}
        {!rows.length && <div class="card empty">Noch keine Personalbögen eingegangen.</div>}
      </>,
    );
  });

  app.post(`/personal/personalboegen/:id{${UUID}}`, async (c) => {
    const b = await c.req.parseBody();
    const status = b.status === 'verworfen' ? 'verworfen' : 'uebernommen';
    await sql`update app.personnel_forms set status = ${status}, decided_by = ${c.get('actor')}, decided_at = now()
               where id = ${c.req.param('id')} and status = 'neu'`;
    return back(c, '/personal/personalboegen', { ok: 'Gespeichert.' });
  });

  // ------------------------------------------------------------------ NU-Auftrag anfragen
  app.get('/qm/nu-auftrag', async (c) => {
    const scope = c.get('sites');
    const [subs, sites] = await Promise.all([
      sql<{ id: string; name: string; supplier_no: string }[]>`
        select id, name, supplier_no from app.suppliers where kind = 'nachunternehmer' and active order by name`,
      sql<
        {
          id: string;
          site_no: string;
          name: string;
          customer_name: string;
          street: string | null;
          city: string | null;
        }[]
      >`
        select s.id, s.site_no, s.name, c.name as customer_name, s.street, s.city
          from app.sites s join app.customers c on c.id = s.customer_id
         where s.active and ${scope ? sql`s.id = any(${scope}::uuid[])` : sql`true`} order by c.name, s.name`,
    ]);
    const objekt = c.req.query('objekt') ?? '';
    return render(
      c,
      'NU-Auftrag anfragen',
      <>
        <Top title="Auftrag für Nachunternehmer" />
        <p class="mut">
          Die Anfrage geht ans Büro. Dort werden Preis und Nachweise geprüft und der Auftrag erteilt – erst
          dann darf der Nachunternehmer arbeiten.
        </p>
        <form method="post" action="/qm/nu-auftrag" class="bogen">
          <input type="hidden" name="id" value={randomUUID()} />
          <label class="bf">
            <span>Nachunternehmer *</span>
            <select name="supplier_id" required>
              <option value="">– bitte wählen –</option>
              {subs.map((x) => (
                <option value={x.id}>
                  {x.name} ({x.supplier_no})
                </option>
              ))}
            </select>
          </label>
          <label class="bf">
            <span>Objekt *</span>
            <select name="site_id" required>
              <option value="">– bitte wählen –</option>
              <SiteOptions sites={sites as never} selected={objekt} />
            </select>
          </label>
          <label class="bf">
            <span>Leistung *</span>
            <input name="service_kind" required placeholder="z. B. Glasreinigung, Grundreinigung Turnhalle" />
          </label>
          <label class="bf">
            <span>Turnus</span>
            <select name="frequency">
              {Object.entries(FREQUENCY).map(([k, v]) => (
                <option value={k}>{v}</option>
              ))}
            </select>
          </label>
          <label class="bf">
            <span>Abrechnung</span>
            <select name="billing">
              {Object.entries(BILLING).map(([k, v]) => (
                <option value={k} selected={k === 'pauschale_einsatz'}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label class="bf">
            <span>Preisvorschlag netto € (falls bekannt)</span>
            <input name="price" inputmode="decimal" placeholder="0,00" />
          </label>
          <label class="bf">
            <span>Beginn *</span>
            <input name="valid_from" type="date" value={todayBerlin()} required />
          </label>
          <label class="bf">
            <span>Ende</span>
            <input name="valid_to" type="date" />
          </label>
          <label class="bf">
            <span>Beschreibung / Begründung</span>
            <textarea
              name="description"
              rows={3}
              placeholder="Was soll gemacht werden, warum, Ansprechpartner vor Ort"
            />
          </label>
          <button class="btn-big">Anfrage ans Büro senden</button>
        </form>
        <style
          dangerouslySetInnerHTML={{
            __html:
              '.bogen{display:flex;flex-direction:column;gap:10px}.bf{display:flex;flex-direction:column;gap:4px;font-weight:600}.bf input,.bf select,.bf textarea{font:inherit;font-weight:400;padding:12px;border:1px solid #e3d6db;border-radius:10px;background:#fff}.btn-big{font:inherit;font-weight:700;padding:14px;border:0;border-radius:12px;background:#7d1435;color:#fff}',
          }}
        />
      </>,
    );
  });

  app.post('/qm/nu-auftrag', async (c) => {
    const b = (await c.req.parseBody({ all: true })) as Record<string, string | File | (string | File)[]>;
    const id = typeof b.id === 'string' && /^[0-9a-f-]{36}$/.test(b.id) ? b.id : randomUUID();
    const siteId = str(b, 'site_id') ?? '';
    assertSite(c, siteId);
    const [done] = await sql`select 1 from app.subcontracts where id = ${id}`;
    if (!done) {
      let price: bigint;
      try {
        price = str(b, 'price') ? parseEuro(str(b, 'price')!) : 0n;
      } catch {
        throw new BusinessError('Preis ungültig');
      }
      await saveSubcontract(
        sql,
        id,
        {
          supplierId: str(b, 'supplier_id') ?? '',
          siteId,
          serviceKind: str(b, 'service_kind') ?? '',
          frequency: str(b, 'frequency') ?? 'einmalig',
          billing: str(b, 'billing') ?? 'pauschale_einsatz',
          priceCents: price < 0n ? 0n : price,
          maxHours: null,
          validFrom: str(b, 'valid_from') ?? todayBerlin(),
          validTo: str(b, 'valid_to'),
          description: str(b, 'description'),
          note: 'Anfrage der Objektleitung – Preis und Nachweise prüfen, dann erteilen',
        },
        c.get('actor'),
      );
      await sql`update app.subcontracts set requested_by = ${c.get('actor')}, request_note = ${str(b, 'description') ?? null} where id = ${id}`;
    }
    return c.redirect(`/qm?ok=${encodeURIComponent('Anfrage ans Büro gesendet – Freigabe folgt.')}`, 303);
  });
}
