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
import { fullName, linkedEmployee } from '../services/users.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import { BusinessError } from '../services/errors.js';
import { storeFile } from '../services/uploads.js';
import {
  SIGN_CATEGORY,
  createSignDocument,
  getSignDocument,
  listSignDocuments,
} from '../services/sign-documents.js';
import {
  getInstructionTemplate,
  instructionPdf,
  listInstructionTemplates,
} from '../services/instructions.js';
import { canAccess } from './permissions.js';
import { photosToPdf } from '../pdf/photos.js';
import { validIban } from '../services/employees.js';
import { normSvNumber, normTaxId, validSvNumber, validTaxId } from '../domain/hr/ids.js';
import { BILLING, FREQUENCY, SERVICE_KINDS, saveSubcontract } from '../services/subcontractors.js';
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
  s_person: 'Wer sind Sie?',
  s_birth: 'Geburt und Herkunft',
  s_address: 'Adresse',
  s_contact: 'Kontakt',
  s_bank: 'Bank und Versicherung',
  s_permit: 'Aufenthalt und Sprachen',
  s_photos: 'Fotos der Unterlagen',
  s_done: 'Fast fertig',
  ph_hint:
    'Bitte die Karten gut lesbar fotografieren (ohne Blitz-Spiegelung). Was Sie nicht haben, einfach überspringen.',
  ph_id: 'Ausweis oder Reisepass (Vorder- und Rückseite)',
  ph_health: 'Krankenkassenkarte',
  ph_bank: 'Bankkarte (IBAN sichtbar)',
  ph_permit: 'Aufenthaltstitel / Arbeitserlaubnis',
  ph_sv: 'Sozialversicherungsausweis',
  ph_other: 'Weitere Unterlagen',
  ph_take: 'Foto aufnehmen',
  ph_more: 'weiteres Foto',
  next: 'Weiter',
  back: 'Zurück',
  step: 'Schritt',
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
    s_person: 'Who are you?',
    s_birth: 'Birth and origin',
    s_address: 'Address',
    s_contact: 'Contact',
    s_bank: 'Bank and insurance',
    s_permit: 'Residence and languages',
    s_photos: 'Photos of your documents',
    s_done: 'Almost done',
    ph_hint:
      'Please photograph the cards so they are easy to read (no flash glare). Skip anything you do not have.',
    ph_id: 'ID card or passport (front and back)',
    ph_health: 'Health insurance card',
    ph_bank: 'Bank card (IBAN visible)',
    ph_permit: 'Residence / work permit',
    ph_sv: 'Social security card',
    ph_other: 'Other documents',
    ph_take: 'Take photo',
    ph_more: 'another photo',
    next: 'Next',
    back: 'Back',
    step: 'Step',
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
    s_person: 'Cine sunteți?',
    s_birth: 'Naștere și origine',
    s_address: 'Adresă',
    s_contact: 'Contact',
    s_bank: 'Bancă și asigurare',
    s_permit: 'Ședere și limbi',
    s_photos: 'Fotografii ale documentelor',
    s_done: 'Aproape gata',
    ph_hint: 'Fotografiați cardurile clar, fără reflexii de bliț. Ce nu aveți, puteți sări.',
    ph_id: 'Buletin sau pașaport (față și verso)',
    ph_health: 'Card de asigurare de sănătate',
    ph_bank: 'Card bancar (IBAN vizibil)',
    ph_permit: 'Permis de ședere / de muncă',
    ph_sv: 'Card de asigurare socială',
    ph_other: 'Alte documente',
    ph_take: 'Faceți o fotografie',
    ph_more: 'altă fotografie',
    next: 'Înainte',
    back: 'Înapoi',
    step: 'Pasul',
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
    s_person: 'Siz kimsiniz?',
    s_birth: 'Doğum ve köken',
    s_address: 'Adres',
    s_contact: 'İletişim',
    s_bank: 'Banka ve sigorta',
    s_permit: 'Oturum ve diller',
    s_photos: 'Belgelerin fotoğrafları',
    s_done: 'Neredeyse bitti',
    ph_hint: 'Kartları okunaklı şekilde fotoğraflayın (flaş yansıması olmadan). Olmayanları atlayın.',
    ph_id: 'Kimlik kartı veya pasaport (ön ve arka)',
    ph_health: 'Sağlık sigortası kartı',
    ph_bank: 'Banka kartı (IBAN görünür)',
    ph_permit: 'Oturum / çalışma izni',
    ph_sv: 'Sosyal sigorta kartı',
    ph_other: 'Diğer belgeler',
    ph_take: 'Fotoğraf çek',
    ph_more: 'başka fotoğraf',
    next: 'İleri',
    back: 'Geri',
    step: 'Adım',
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
    s_person: 'Kim Pan/Pani jest?',
    s_birth: 'Urodzenie i pochodzenie',
    s_address: 'Adres',
    s_contact: 'Kontakt',
    s_bank: 'Bank i ubezpieczenie',
    s_permit: 'Pobyt i języki',
    s_photos: 'Zdjęcia dokumentów',
    s_done: 'Prawie gotowe',
    ph_hint: 'Proszę sfotografować karty czytelnie (bez odblasku lampy). To, czego nie ma, można pominąć.',
    ph_id: 'Dowód osobisty lub paszport (przód i tył)',
    ph_health: 'Karta ubezpieczenia zdrowotnego',
    ph_bank: 'Karta bankowa (widoczny IBAN)',
    ph_permit: 'Dokument pobytowy / pozwolenie na pracę',
    ph_sv: 'Legitymacja ubezpieczenia społecznego',
    ph_other: 'Inne dokumenty',
    ph_take: 'Zrób zdjęcie',
    ph_more: 'kolejne zdjęcie',
    next: 'Dalej',
    back: 'Wstecz',
    step: 'Krok',
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
    s_person: 'Tko ste vi?',
    s_birth: 'Rođenje i podrijetlo',
    s_address: 'Adresa',
    s_contact: 'Kontakt',
    s_bank: 'Banka i osiguranje',
    s_permit: 'Boravak i jezici',
    s_photos: 'Fotografije dokumenata',
    s_done: 'Skoro gotovo',
    ph_hint: 'Fotografirajte kartice čitljivo (bez odsjaja bljeskalice). Ono što nemate preskočite.',
    ph_id: 'Osobna iskaznica ili putovnica (prednja i stražnja strana)',
    ph_health: 'Kartica zdravstvenog osiguranja',
    ph_bank: 'Bankovna kartica (vidljiv IBAN)',
    ph_permit: 'Boravišna / radna dozvola',
    ph_sv: 'Iskaznica socijalnog osiguranja',
    ph_other: 'Ostali dokumenti',
    ph_take: 'Fotografiraj',
    ph_more: 'još jedna fotografija',
    next: 'Dalje',
    back: 'Natrag',
    step: 'Korak',
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
    s_person: 'Кои сте вие?',
    s_birth: 'Раждане и произход',
    s_address: 'Адрес',
    s_contact: 'Контакт',
    s_bank: 'Банка и осигуровка',
    s_permit: 'Пребиваване и езици',
    s_photos: 'Снимки на документите',
    s_done: 'Почти готово',
    ph_hint: 'Моля, снимайте картите четливо (без отблясък от светкавица). Каквото нямате, пропуснете.',
    ph_id: 'Лична карта или паспорт (лице и гръб)',
    ph_health: 'Карта на здравната каса',
    ph_bank: 'Банкова карта (видим IBAN)',
    ph_permit: 'Разрешение за пребиваване / работа',
    ph_sv: 'Карта за социално осигуряване',
    ph_other: 'Други документи',
    ph_take: 'Направете снимка',
    ph_more: 'още една снимка',
    next: 'Напред',
    back: 'Назад',
    step: 'Стъпка',
  },
};
/**
 * Formular Schritt für Schritt: Abschnitte [data-step] einzeln, Weiter prüft die Pflichtfelder des Abschnitts,
 * „Absenden“ erst im letzten Schritt. Ohne JavaScript bleibt alles auf einer Seite.
 */
const WIZARD_CSS =
  '.bogen{display:flex;flex-direction:column;gap:10px}.wstep{display:flex;flex-direction:column;gap:12px}.wstep[hidden]{display:none}.wtitle{margin:4px 0 2px;font-size:22px;line-height:1.2}.wprog{height:6px;background:#efe6ea;border-radius:6px;overflow:hidden}.wprog-bar{height:100%;width:0;background:#7d1435;transition:width .2s}.wnav{display:flex;align-items:center;gap:10px;margin-top:10px;position:sticky;bottom:0;z-index:5;background:#f6f2f4;padding:10px 0 calc(10px + env(safe-area-inset-bottom,0px))}.wbtn{font:inherit;font-size:16px;font-weight:700;min-width:96px;padding:14px;border:0;border-radius:12px;background:#7d1435;color:#fff}.wbtn.sec{background:#fff;color:#7d1435;border:1px solid #e3d6db}.wcount{flex:1;text-align:center;color:#8a7a80;font-weight:600}.wnav .btn-big{flex:1}.bf{display:flex;flex-direction:column;gap:4px;font-weight:600}.bf input,.bf select,.bf textarea{font:inherit;font-size:17px;font-weight:400;padding:13px;border:1px solid #e3d6db;border-radius:10px;background:#fff}.btn-big{font:inherit;font-weight:700;padding:14px;border:0;border-radius:12px;background:#7d1435;color:#fff}';
export const WIZARD_JS = `(function(){document.querySelectorAll('form').forEach(function(f){var st=[].slice.call(f.querySelectorAll('[data-step]'));if(st.length<2)return;var i=0,prev=f.querySelector('[data-prev]'),next=f.querySelector('[data-next]'),sub=f.querySelector('[data-submit]'),cnt=f.querySelector('[data-count]');
function show(){st.forEach(function(s,k){s.hidden=k!==i});prev.style.visibility=i?'visible':'hidden';next.hidden=i===st.length-1;sub.hidden=i!==st.length-1;if(cnt)cnt.textContent=(i+1)+' / '+st.length;var bar=f.querySelector('[data-bar]');if(bar)bar.style.width=((i+1)/st.length*100)+'%';var m=f.closest('main');(m||window).scrollTo(0,0)}
function ok(){var els=st[i].querySelectorAll('input,select,textarea');for(var k=0;k<els.length;k++){if(!els[k].checkValidity()){els[k].reportValidity();return false}}return true}
next.addEventListener('click',function(){if(ok()){i++;show()}});prev.addEventListener('click',function(){if(i){i--;show()}});
f.addEventListener('invalid',function(e){var s=e.target.closest('[data-step]');var k=st.indexOf(s);if(k>=0&&k!==i){i=k;show()}},true);show()})})();`;

/** Schritte des Personalbogens: Titel-Schlüssel + Felder. */
const BOGEN_STEPS: [string, string[]][] = [
  ['s_person', ['salutation', 'first_name', 'last_name']],
  ['s_birth', ['birth_date', 'birth_place', 'birth_country', 'nationality', 'marital_status']],
  ['s_address', ['street', 'postal_code', 'city']],
  ['s_contact', ['mobile', 'email_private', 'emergency_contact']],
  ['s_bank', ['iban', 'tax_id', 'social_security_no', 'health_insurance']],
  ['s_permit', ['residence_permit_until', 'work_permit_until', 'languages']],
  ['s_photos', []],
  ['s_done', ['notes']],
];
/** Foto-Arten im Personalbogen (Formularname = Schlüssel). */
export const PHOTO_KINDS = ['ph_id', 'ph_health', 'ph_bank', 'ph_permit', 'ph_sv', 'ph_other'] as const;

/**
 * Fotos: Kamera-Feld je Art, Bild im Browser auf höchstens 1600 px als JPEG verkleinern (sonst 5 MB je Handyfoto)
 * und im versteckten Sammelfeld der Art ablegen (DataTransfer). Vorschaubilder mit × zum Entfernen.
 */
const PHOTO_JS = `(function(){document.querySelectorAll('[data-photos]').forEach(function(box){var store=box.querySelector('.phk-store'),cam=box.querySelector('.phk-cam'),list=box.querySelector('.phk-list'),files=[];
function sync(){try{var dt=new DataTransfer();files.forEach(function(f){dt.items.add(f)});store.files=dt.files}catch(e){}list.innerHTML='';files.forEach(function(f,i){var d=document.createElement('div');d.className='phk-t';var im=document.createElement('img');im.src=URL.createObjectURL(f);var x=document.createElement('button');x.type='button';x.textContent='×';x.onclick=function(){files.splice(i,1);sync()};d.appendChild(im);d.appendChild(x);list.appendChild(d)})}
function shrink(f,cb){var img=new Image();img.onload=function(){var m=1600,w=img.naturalWidth,h=img.naturalHeight,r=Math.min(1,m/Math.max(w,h));var c=document.createElement('canvas');c.width=Math.round(w*r);c.height=Math.round(h*r);c.getContext('2d').drawImage(img,0,0,c.width,c.height);c.toBlob(function(b){cb(b?new File([b],(f.name||'foto').replace(/\\.[^.]*$/,'')+'.jpg',{type:'image/jpeg'}):f)},'image/jpeg',0.82)};img.onerror=function(){cb(f)};img.src=URL.createObjectURL(f)}
cam.addEventListener('change',function(){[].slice.call(cam.files).forEach(function(f){shrink(f,function(g){files.push(g);sync()})});cam.value=''})})})();`;

const tr = (lang: Lang, k: string) => (lang === 'de' ? DE[k] : (T[lang][k] ?? DE[k])) ?? k;

export function registerOlAppRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;
  const render = async (c: Context<AppEnv>, title: string, body: Child) =>
    c.html(
      '<!doctype html>' +
        String(
          <QmLayout
            ownTime={!!(await linkedEmployee(sql, c.get('user').id))}
            userName={fullName(c.get('user'))}
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
        <form
          method="post"
          action="/qm/personalbogen"
          class="bogen"
          lang={lang}
          enctype="multipart/form-data"
        >
          <input type="hidden" name="id" value={randomUUID()} />
          <input type="hidden" name="lang" value={lang} />
          <input type="hidden" name="objekt" value={objekt} />
          <div class="wprog">
            <div class="wprog-bar" data-bar />
          </div>
          {/* Kleine Schritte (Ahmed 15.10.: „zuerst nur Name, Adresse, dann weiter, nicht ewig lange Listen“) */}
          {BOGEN_STEPS.map(([title, keys]) => (
            <div class="wstep" data-step>
              <h2 class="wtitle">
                {L(title)}
                {lang !== 'de' && <small>{DE[title]}</small>}
              </h2>
              {title === 's_photos' ? (
                <>
                  <p class="small mut" style="margin:0">
                    {L('ph_hint')}
                  </p>
                  {PHOTO_KINDS.map((k) => (
                    <div class="phk" data-photos={k}>
                      <div class="phk-h">
                        <b>{L(k)}</b>
                        {lang !== 'de' && <small>{DE[k]}</small>}
                      </div>
                      <div class="phk-list" />
                      <input type="file" name={k} accept="image/*" multiple hidden class="phk-store" />
                      <label class="phk-add">
                        <input type="file" accept="image/*" capture="environment" class="phk-cam" />
                        <span>+ {L('ph_take')}</span>
                      </label>
                    </div>
                  ))}
                </>
              ) : (
                keys.map((key) => {
                  const f = BOGEN_FIELDS.find((x) => x.key === key)!;
                  return (
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
                          {...(f.key === 'mobile' ? { inputmode: 'tel' } : {})}
                        />
                      )}
                    </label>
                  );
                })
              )}
              {title === 's_done' && (
                <>
                  <p class="small mut">{L('privacy')}</p>
                  <label class="bf chk">
                    <input type="checkbox" name="confirm" value="1" required /> {L('confirm')}
                  </label>
                </>
              )}
            </div>
          ))}
          <div class="wnav">
            <button type="button" class="wbtn sec" data-prev>
              {L('back')}
            </button>
            <span class="wcount" data-count />
            <button type="button" class="wbtn" data-next>
              {L('next')}
            </button>
            <button class="btn-big" data-submit>
              {L('send')}
            </button>
          </div>
        </form>
        <script dangerouslySetInnerHTML={{ __html: WIZARD_JS + PHOTO_JS }} />
        <style
          dangerouslySetInnerHTML={{
            __html:
              '.bogen{display:flex;flex-direction:column;gap:10px}.wstep{display:flex;flex-direction:column;gap:12px}.wstep[hidden]{display:none}.wtitle{margin:4px 0 2px;font-size:22px;line-height:1.2}.wtitle small{display:block;font-size:12px;font-weight:400;color:#8a7a80}.wprog{height:6px;background:#efe6ea;border-radius:6px;overflow:hidden}.wprog-bar{height:100%;width:0;background:#7d1435;transition:width .2s}.wnav{display:flex;align-items:center;gap:10px;margin-top:10px;position:sticky;bottom:0;z-index:5;background:#f6f2f4;padding:10px 0 calc(10px + env(safe-area-inset-bottom,0px))}.wbtn{font:inherit;font-size:16px;font-weight:700;min-width:96px;padding:14px;border:0;border-radius:12px;background:#7d1435;color:#fff}.wbtn.sec{background:#fff;color:#7d1435;border:1px solid #e3d6db}.wcount{flex:1;text-align:center;color:#8a7a80;font-weight:600}.wnav .btn-big{flex:1}.bf{display:flex;flex-direction:column;gap:4px;font-weight:600}.bf small{display:block;font-weight:400;color:#8a7a80;font-size:12px}.bf input,.bf select,.bf textarea{font:inherit;font-size:17px;font-weight:400;padding:13px;border:1px solid #e3d6db;border-radius:10px;background:#fff}.bf.chk{flex-direction:row;align-items:center;gap:10px}.btn-big{font:inherit;font-weight:700;padding:14px;border:0;border-radius:12px;background:#7d1435;color:#fff}.phk{background:#fff;border:1px solid #e7e1e4;border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px}.phk-h small{display:block;font-size:12px;color:#8a7a80}.phk-list{display:flex;flex-wrap:wrap;gap:8px}.phk-list:empty{display:none}.phk-t{position:relative;width:84px;height:64px;border-radius:8px;overflow:hidden;border:1px solid #e3d6db}.phk-t img{width:100%;height:100%;object-fit:cover}.phk-t button{position:absolute;top:2px;right:2px;width:24px;height:24px;border-radius:12px;border:0;background:rgba(0,0,0,.6);color:#fff;font-size:15px;line-height:1}.phk-add{display:block;text-align:center;padding:12px;border:1.5px dashed #cdbfc5;border-radius:10px;color:#7d1435;font-weight:600}.phk-add input{display:none}',
          }}
        />
      </>,
    );
  });

  app.post('/qm/personalbogen', async (c) => {
    const b = (await c.req.parseBody({ all: true })) as Record<string, string | File | (string | File)[]>;
    const photos: { kind: string; file: File }[] = [];
    for (const k of PHOTO_KINDS) {
      const v = b[k];
      for (const f of Array.isArray(v) ? v : v ? [v] : [])
        if (f instanceof File && f.size > 0) photos.push({ kind: k, file: f });
      b[k] = '';
    }
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
    // Nummern gleich hier prüfen (Tippfehler fallen sonst erst im Büro auf)
    if (data.iban && !validIban(data.iban))
      throw new BusinessError(`${tr(lang, 'iban')}: ungültig (Prüfziffer)`);
    if (data.tax_id) {
      data.tax_id = normTaxId(data.tax_id);
      if (!validTaxId(data.tax_id)) throw new BusinessError(`${tr(lang, 'tax_id')}: ungültig (Prüfziffer)`);
    }
    if (data.social_security_no) {
      data.social_security_no = normSvNumber(data.social_security_no);
      if (!validSvNumber(data.social_security_no))
        throw new BusinessError(`${tr(lang, 'social_security_no')}: ungültig (Prüfziffer)`);
    }
    const site = typeof b.objekt === 'string' && /^[0-9a-f-]{36}$/.test(b.objekt) ? b.objekt : null;
    if (site) assertSite(c, site);
    const [done] = await sql`select 1 from app.personnel_forms where id = ${id}`;
    if (!done) {
      // Erst das PDF der Fotos (kann scheitern, z. B. Format), dann den Bogen speichern → nichts halb gespeichert
      let fileId: string | null = null;
      if (photos.length) {
        const pdf = await photosToPdf(
          photos.map((p) => ({ label: DE[p.kind] ?? p.kind, file: p.file })),
          `${data.last_name ?? ''}, ${data.first_name ?? ''}`,
        );
        fileId = randomUUID();
        await storeFile(
          sql,
          { dir: deps.env.FILES_DIR, maxBytes: deps.env.UPLOAD_MAX_BYTES },
          {
            id: fileId,
            name: `Personalbogen_Unterlagen_${data.last_name ?? ''}_${data.first_name ?? ''}.pdf`,
            type: 'application/pdf',
            data: pdf,
            link: { type: 'personnel_form', id },
            category: 'Personalunterlagen',
          },
          c.get('actor'),
        );
      }
      await sql`insert into app.personnel_forms (id, lang, site_id, data, created_by, docs_file_id)
                values (${id}, ${lang}, ${site}, ${sql.json(data)}, ${c.get('actor')}, ${fileId})
                on conflict (id) do nothing`;
    }
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
        docs_file_id: string | null;
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
            {r.docs_file_id && (
              <p>
                <a
                  class="btn sec sm"
                  href={`/personal/personalboegen/${r.id}/unterlagen.pdf`}
                  target="_blank"
                >
                  Fotos der Unterlagen (PDF)
                </a>{' '}
                <span class="small mut">
                  {r.employee_id ? 'liegt in der Personalakte' : 'kommt beim Anlegen in die Personalakte'}
                </span>
              </p>
            )}
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

  app.get(`/personal/personalboegen/:id{${UUID}}/unterlagen.pdf`, async (c) => {
    const [f] = await sql<{ storage_path: string }[]>`
      select f.storage_path from app.personnel_forms p join app.files f on f.id = p.docs_file_id
       where p.id = ${c.req.param('id')}`;
    if (!f) return c.notFound();
    const bytes = await readFile(join(resolve(deps.env.FILES_DIR), f.storage_path));
    return new Response(bytes, {
      headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store' },
    });
  });

  app.post(`/personal/personalboegen/:id{${UUID}}`, async (c) => {
    const b = await c.req.parseBody();
    const status = b.status === 'verworfen' ? 'verworfen' : 'uebernommen';
    await sql`update app.personnel_forms set status = ${status}, decided_by = ${c.get('actor')}, decided_at = now()
               where id = ${c.req.param('id')} and status = 'neu'`;
    return back(c, '/personal/personalboegen', { ok: 'Gespeichert.' });
  });

  // ------------------------------------------------------------------ Unterweisungen am Handy (Büro/Personal)
  const mayInstruct = (c: Context<AppEnv>) => canAccess(c.get('user').role, '/personal/dokumente');
  const QMU_CSS =
    '.qu{display:flex;flex-direction:column;gap:8px}.qu-i{display:block;background:#fff;border:1px solid #e7e1e4;border-radius:12px;padding:12px 14px;text-decoration:none;color:inherit}.qu-i b{display:block;font-size:15px}.qu-m{font-size:12px;color:#8a7a80;margin-top:2px}.qu-bar{height:6px;background:#efe6ea;border-radius:4px;overflow:hidden;margin-top:8px}.qu-bar i{display:block;height:100%;background:#2f7d4f}.qu-new{display:block;text-align:center;padding:14px;border-radius:12px;background:#7d1435;color:#fff;font-weight:700;text-decoration:none;margin-bottom:12px}.qu-p{display:flex;justify-content:space-between;gap:8px;padding:10px 0;border-bottom:1px solid #f0ebed;font-size:14px}.qu-ok{color:#2f7d4f;font-weight:600}.qu-open{color:#a15c00;font-weight:600}.qu-t{display:flex;flex-direction:column;gap:6px}.qu-t label{display:flex;gap:10px;align-items:flex-start;background:#fff;border:1px solid #e7e1e4;border-radius:12px;padding:12px;font-weight:600}.qu-t input{margin-top:3px;width:20px;height:20px}.qu-emps{max-height:320px;overflow:auto;background:#fff;border:1px solid #e7e1e4;border-radius:12px;padding:4px 10px}.qu-emps label{display:flex;gap:12px;align-items:center;justify-content:flex-start;text-align:left;margin:0;padding:10px 0;border-bottom:1px solid #f4f0f2;font-weight:400;color:#2a1420;font-size:16px}.qu-emps label .qn{flex:1;min-width:0}';

  app.get('/qm/unterweisungen', async (c) => {
    if (!mayInstruct(c)) return c.redirect('/qm');
    const docs = (await listSignDocuments(sql)).filter((d) => !d.archived_at);
    return render(
      c,
      'Unterweisungen',
      <>
        <Top title="Unterweisungen" />
        <a class="qu-new" href="/qm/unterweisungen/neu">
          + Unterweisung freigeben
        </a>
        {!docs.length && <p class="mut">Noch keine Unterweisungen freigegeben.</p>}
        <div class="qu">
          {docs.map((d) => (
            <a class="qu-i" href={`/qm/unterweisungen/${d.id}`}>
              <b>{d.title}</b>
              <div class="qu-m">
                {d.signed} von {d.total} unterschrieben
                {d.open ? ` · ${d.open} offen` : ''}
                {d.due_date ? ` · bis ${dateDe(d.due_date)}` : ''}
              </div>
              <div class="qu-bar">
                <i style={`width:${d.total ? Math.round((d.signed / d.total) * 100) : 0}%`} />
              </div>
            </a>
          ))}
        </div>
        <style dangerouslySetInnerHTML={{ __html: QMU_CSS }} />
      </>,
    );
  });

  app.get('/qm/unterweisungen/neu', async (c) => {
    if (!mayInstruct(c)) return c.redirect('/qm');
    const [its, sites, emps] = await Promise.all([
      listInstructionTemplates(sql),
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
          from app.sites s join app.customers c on c.id = s.customer_id where s.active order by c.name, s.name`,
      sql<{ id: string; name: string; personnel_no: string }[]>`
        select id, last_name || ', ' || first_name as name, personnel_no from app.employees
         where status = 'aktiv' order by last_name, first_name`,
    ]);
    return render(
      c,
      'Unterweisung freigeben',
      <>
        <Top title="Unterweisung freigeben" href="/qm/unterweisungen" />
        <form method="post" action="/qm/unterweisungen" class="bogen">
          <input type="hidden" name="id" value={randomUUID()} />
          <div class="wprog">
            <div class="wprog-bar" data-bar />
          </div>
          <div class="wstep" data-step>
            <h2 class="wtitle">Welche Unterweisung?</h2>
            <div class="qu-t">
              {its.map((t, i) => (
                <label>
                  <input type="radio" name="instruction" value={t.id} required={i === 0} />
                  <span>
                    {t.title}
                    <div class="qu-m">{SIGN_CATEGORY[t.category]}</div>
                  </span>
                </label>
              ))}
            </div>
            {!its.length && (
              <p class="mut">Keine Vorlagen – am PC unter Einstellungen → Unterweisungen anlegen.</p>
            )}
          </div>
          <div class="wstep" data-step>
            <h2 class="wtitle">An wen?</h2>
            <label class="bf">
              <span>Empfänger</span>
              <select
                name="an"
                onchange="document.getElementById('qu-site').hidden=this.value!=='objekt';document.getElementById('qu-sel').hidden=this.value!=='auswahl'"
              >
                <option value="alle">alle aktiven Mitarbeitenden ({emps.length})</option>
                <option value="objekt">alle eines Objekts</option>
                <option value="auswahl">einzelne auswählen</option>
              </select>
            </label>
            <label class="bf" id="qu-site" hidden>
              <span>Objekt</span>
              <select name="site_id">
                <option value="">– bitte wählen –</option>
                <SiteOptions sites={sites as never} selected="" />
              </select>
            </label>
            <div id="qu-sel" hidden>
              <input
                type="search"
                placeholder="Name oder Personalnummer"
                data-filter-list=".qu-emps label"
                style="width:100%;font:inherit;padding:12px;border:1px solid #e3d6db;border-radius:10px;margin-bottom:8px"
                oninput="var q=this.value.toLowerCase();document.querySelectorAll('.qu-emps label').forEach(function(l){l.hidden=q&&l.textContent.toLowerCase().indexOf(q)<0})"
              />
              <div class="qu-emps">
                {emps.map((e) => (
                  <label>
                    <input type="checkbox" name="employee" value={e.id} />
                    <span class="qn">{e.name}</span>
                    <span class="qu-m">{e.personnel_no}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div class="wstep" data-step>
            <h2 class="wtitle">Frist</h2>
            <label class="bf">
              <span>Unterschreiben bis (optional)</span>
              <input type="date" name="due_date" />
            </label>
            <p class="small mut">
              Die Unterweisung erscheint beim nächsten Öffnen der Mitarbeiter-App zum Lesen und
              Unterschreiben.
            </p>
          </div>
          <div class="wnav">
            <button type="button" class="wbtn sec" data-prev>
              Zurück
            </button>
            <span class="wcount" data-count />
            <button type="button" class="wbtn" data-next>
              Weiter
            </button>
            <button class="btn-big" data-submit>
              Freigeben
            </button>
          </div>
        </form>
        <script dangerouslySetInnerHTML={{ __html: WIZARD_JS }} />
        <style dangerouslySetInnerHTML={{ __html: QMU_CSS + WIZARD_CSS }} />
      </>,
    );
  });

  app.post('/qm/unterweisungen', async (c) => {
    if (!mayInstruct(c)) return c.redirect('/qm');
    const b = (await c.req.parseBody({ all: true })) as Record<string, string | File | (string | File)[]>;
    const id = typeof b.id === 'string' && /^[0-9a-f-]{36}$/.test(b.id) ? b.id : randomUUID();
    const t = await getInstructionTemplate(sql, str(b, 'instruction') ?? '');
    if (!t) throw new BusinessError('Bitte eine Unterweisung wählen');
    const an = str(b, 'an') ?? 'alle';
    let employeeIds: string[];
    if (an === 'objekt') {
      const site = str(b, 'site_id') ?? '';
      if (!/^[0-9a-f-]{36}$/.test(site)) throw new BusinessError('Bitte Objekt wählen');
      employeeIds = (
        await sql<{ id: string }[]>`
          select distinct e.id from app.employees e
           where e.status = 'aktiv'
             and (exists (select 1 from app.employee_sites es where es.employee_id = e.id and es.site_id = ${site})
                  or exists (select 1 from app.shift_plans sp where sp.employee_id = e.id and sp.site_id = ${site}
                               and (sp.valid_to is null or sp.valid_to >= ${todayBerlin()}::date)))`
      ).map((r) => r.id);
    } else if (an === 'auswahl') {
      const v = b.employee;
      employeeIds = (Array.isArray(v) ? v : v ? [v] : []).filter(
        (x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/.test(x),
      );
    } else {
      employeeIds = (await sql<{ id: string }[]>`select id from app.employees where status = 'aktiv'`).map(
        (r) => r.id,
      );
    }
    await createSignDocument(
      deps,
      id,
      {
        title: t.title,
        category: t.category,
        description: null,
        dueDate: str(b, 'due_date'),
        fileName: `${t.title.replace(/[^\p{L}\p{N}]+/gu, '-')}.pdf`,
        pdf: await instructionPdf(t.title, t.body),
        body: t.body,
        employeeIds,
      },
      c.get('actor'),
    );
    return c.redirect(`/qm/unterweisungen/${id}?ok=${encodeURIComponent('Unterweisung freigegeben.')}`, 303);
  });

  app.get(`/qm/unterweisungen/:id{${UUID}}`, async (c) => {
    if (!mayInstruct(c)) return c.redirect('/qm');
    const data = await getSignDocument(sql, c.req.param('id'));
    if (!data) return c.redirect('/qm/unterweisungen');
    const reqs = data.requests.filter((r) => r.status !== 'zurueckgezogen');
    const open = reqs.filter((r) => r.status === 'offen');
    const signed = reqs.filter((r) => r.status === 'unterschrieben');
    return render(
      c,
      data.doc.title,
      <>
        <Top title="Unterweisung" href="/qm/unterweisungen" />
        <h2 class="wtitle" style="margin:0 0 4px">
          {data.doc.title}
        </h2>
        <div class="qu-m" style="margin-bottom:10px">
          {signed.length} von {reqs.length} unterschrieben
          {data.doc.due_date ? ` · bis ${dateDe(data.doc.due_date)}` : ''}
        </div>
        <div class="qu-bar" style="margin-bottom:14px">
          <i style={`width:${reqs.length ? Math.round((signed.length / reqs.length) * 100) : 0}%`} />
        </div>
        {open.length > 0 && (
          <div class="qu-i" style="margin-bottom:10px">
            <b>Offen ({open.length})</b>
            {open.map((r) => (
              <div class="qu-p">
                <span>{r.employee_name}</span>
                <span class="qu-open">offen</span>
              </div>
            ))}
          </div>
        )}
        {signed.length > 0 && (
          <div class="qu-i">
            <b>Unterschrieben ({signed.length})</b>
            {signed.map((r) => (
              <div class="qu-p">
                <span>{r.employee_name}</span>
                <span class="qu-ok">
                  ✓{' '}
                  {r.signed_at?.toLocaleDateString('de-DE', {
                    timeZone: 'Europe/Berlin',
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                  })}
                </span>
              </div>
            ))}
          </div>
        )}
        <style dangerouslySetInnerHTML={{ __html: QMU_CSS + WIZARD_CSS }} />
      </>,
    );
  });

  // ------------------------------------------------------------------ NU-Bestellung am Handy unterschreiben lassen
  app.get('/qm/nu-unterschrift', async (c) => {
    const scope = c.get('sites');
    const rows = await sql<
      {
        id: string;
        number: string;
        supplier_name: string;
        site_name: string;
        site_no: string;
        service_kind: string;
        valid_from: string;
      }[]
    >`
      select sc.id, sc.number, sp.name as supplier_name, s.name as site_name, s.site_no, sc.service_kind,
             sc.valid_from::text
        from app.subcontracts sc join app.suppliers sp on sp.id = sc.supplier_id join app.sites s on s.id = sc.site_id
       where sc.status = 'erteilt' and sc.signed_file_path is null and sc.signed_external is null
         and ${scope ? sql`sc.site_id = any(${scope}::uuid[])` : sql`true`}
       order by sc.valid_from desc, sc.number desc`;
    const ok = c.req.query('ok');
    return render(
      c,
      'NU unterschreiben',
      <>
        <Top title="Bestellung unterschreiben" />
        {ok && <p class="nul-ok">{ok}</p>}
        <p class="mut" style="margin:0 0 10px">
          Bestellung antippen, dem Nachunternehmer das Handy geben, unterschreiben lassen.
        </p>
        {rows.length === 0 && <p class="nul-empty">Keine offenen Bestellungen zum Unterschreiben.</p>}
        <div class="nul">
          {rows.map((r) => (
            <a class="nul-i" href={`/nachunternehmer/auftraege/${r.id}/unterschreiben?von=app`}>
              <span class="nul-t">
                <b>{r.supplier_name}</b>
                <span>
                  {r.site_name} ({r.site_no}) · {r.service_kind}
                </span>
                <span class="nul-m">
                  {r.number} · ab {r.valid_from.split('-').reverse().join('.')}
                </span>
              </span>
              <span class="nul-go">›</span>
            </a>
          ))}
        </div>
        <style
          dangerouslySetInnerHTML={{
            __html:
              '.nul{display:flex;flex-direction:column;gap:8px}.nul-i{display:flex;align-items:center;gap:10px;background:#fff;border:1px solid #e7e1e4;border-radius:12px;padding:12px 14px;text-decoration:none;color:inherit}.nul-t{flex:1;display:flex;flex-direction:column;gap:2px;min-width:0}.nul-t b{font-size:15px}.nul-t span{font-size:13px;color:#5a4f53}.nul-t .nul-m{font-size:12px;color:#8a7a80}.nul-go{font-size:24px;color:#7d1435}.nul-ok{background:#eaf6ee;color:#1d6b3a;border-radius:10px;padding:10px 12px;margin:0 0 10px;font-weight:600}.nul-empty{background:#fff;border:1px dashed #e3d6db;border-radius:12px;padding:16px;text-align:center;color:#8a7a80}',
          }}
        />
      </>,
    );
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
            <select name="service_kind" required>
              <option value="">– Leistung wählen –</option>
              {SERVICE_KINDS.map((k) => (
                <option value={k}>{k}</option>
              ))}
            </select>
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
              '.bogen{display:flex;flex-direction:column;gap:10px}.wstep{display:flex;flex-direction:column;gap:10px}.wnav{display:flex;align-items:center;gap:10px;margin-top:8px}.wbtn{font:inherit;font-size:22px;font-weight:700;min-width:64px;padding:12px;border:0;border-radius:12px;background:#7d1435;color:#fff}.wbtn.sec{background:#fff;color:#7d1435;border:1px solid #e3d6db}.wcount{flex:1;text-align:center;color:#8a7a80;font-weight:600}.wnav .btn-big{flex:1}.bf{display:flex;flex-direction:column;gap:4px;font-weight:600}.bf input,.bf select,.bf textarea{font:inherit;font-weight:400;padding:12px;border:1px solid #e3d6db;border-radius:10px;background:#fff}.btn-big{font:inherit;font-weight:700;padding:14px;border:0;border-radius:12px;background:#7d1435;color:#fff}',
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
      // Aufgabe fürs Büro (Startseite „Aufgaben“, Erinnerungen) – wird beim Erteilen erledigt
      const [info] = await sql<{ number: string; supplier: string; site: string }[]>`
        select sc.number, sp.name as supplier, s.name as site
          from app.subcontracts sc join app.suppliers sp on sp.id = sc.supplier_id join app.sites s on s.id = sc.site_id
         where sc.id = ${id}`;
      if (info) {
        await sql`
          insert into app.tasks (id, title, description, due_date, status, created_by)
          values (md5(${'nu-anfrage:' + id})::uuid,
                  ${`NU-Auftrag freigeben: ${info.supplier} – ${info.site}`},
                  ${`Anfrage ${info.number} von ${c.get('actor')}: ${str(b, 'service_kind') ?? ''}. Preis und Nachweise prüfen, dann erteilen. /nachunternehmer/auftraege/${id}`},
                  ${todayBerlin()}, 'open', ${c.get('actor')})
          on conflict (id) do nothing`;
      }
    }
    return c.redirect(`/qm?ok=${encodeURIComponent('Anfrage ans Büro gesendet – Freigabe folgt.')}`, 303);
  });
}
