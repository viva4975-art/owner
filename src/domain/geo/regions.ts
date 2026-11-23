// Vertriebsregionen für die Akquise (Ahmed 23.11.): Region aus dem Ort erkennen, wenn keine eingetragen ist.
// Großraum = Stadt + umliegende Orte; PLZ-Bereiche als Rückfall. Unbekannt → null („ohne Region“).

export const REGIONS: Record<string, string[]> = {
  München: [
    'münchen',
    'garching',
    'unterschleißheim',
    'oberschleißheim',
    'ismaning',
    'unterföhring',
    'haar',
    'ottobrunn',
    'neubiberg',
    'unterhaching',
    'taufkirchen',
    'oberhaching',
    'pullach',
    'grünwald',
    'planegg',
    'martinsried',
    'gräfelfing',
    'germering',
    'puchheim',
    'gauting',
    'starnberg',
    'dachau',
    'freising',
    'erding',
    'fürstenfeldbruck',
    'olching',
    'gröbenzell',
    'karlsfeld',
    'poing',
    'vaterstetten',
    'feldkirchen',
    'aschheim',
    'kirchheim bei münchen',
    'hallbergmoos',
    'eching',
    'neufahrn',
    'höhenkirchen',
    'sauerlach',
    'holzkirchen',
    'wolfratshausen',
    'geretsried',
    'ebersberg',
    'grafing',
    'markt schwaben',
    'putzbrunn',
    'brunnthal',
    'hohenbrunn',
    'krailling',
    'neuried',
    'baierbrunn',
    'unterpfaffenhofen',
    'gilching',
    'maisach',
    'bergkirchen',
  ],
  Stuttgart: [
    'stuttgart',
    'esslingen',
    'ludwigsburg',
    'böblingen',
    'sindelfingen',
    'leonberg',
    'fellbach',
    'waiblingen',
    'filderstadt',
    'leinfelden-echterdingen',
    'ostfildern',
    'kornwestheim',
    'ditzingen',
    'gerlingen',
    'remseck',
    'bietigheim-bissingen',
    'göppingen',
    'nürtingen',
    'kirchheim unter teck',
    'schorndorf',
    'herrenberg',
    'backnang',
    'korntal',
    'möglingen',
    'asperg',
    'weinstadt',
    'winnenden',
    'plochingen',
    'denkendorf',
    'neuhausen auf den fildern',
  ],
  Ingolstadt: [
    'ingolstadt',
    'neuburg',
    'pfaffenhofen',
    'eichstätt',
    'gaimersheim',
    'manching',
    'kösching',
    'lenting',
    'wettstetten',
    'großmehring',
    'vohburg',
    'geisenfeld',
    'schrobenhausen',
    'kipfenberg',
    'beilngries',
    'reichertshofen',
    'baar-ebenhausen',
    'karlskron',
    'hepberg',
    'stammham',
    'denkendorf bei ingolstadt',
  ],
  Augsburg: [
    'augsburg',
    'friedberg',
    'königsbrunn',
    'gersthofen',
    'neusäß',
    'stadtbergen',
    'bobingen',
    'aichach',
    'schwabmünchen',
    'diedorf',
    'mering',
    'meitingen',
  ],
  Nürnberg: [
    'nürnberg',
    'fürth',
    'erlangen',
    'schwabach',
    'zirndorf',
    'stein',
    'oberasbach',
    'lauf an der pegnitz',
    'feucht',
    'herzogenaurach',
    'röthenbach',
  ],
  Regensburg: ['regensburg', 'neutraubling', 'regenstauf', 'lappersdorf', 'pentling', 'obertraubling'],
};

/** PLZ-Anfang → Region (Rückfall, wenn der Ort nicht in der Liste steht). */
const PLZ: [string, string][] = [
  ['8504', 'Ingolstadt'],
  ['8505', 'Ingolstadt'],
  ['861', 'Augsburg'],
  ['80', 'München'],
  ['81', 'München'],
  ['70', 'Stuttgart'],
  ['90', 'Nürnberg'],
  ['930', 'Regensburg'],
];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const TOWNS = Object.entries(REGIONS)
  .flatMap(([r, ts]) => ts.map((t) => [norm(t), r] as const))
  .sort((a, b) => b[0].length - a[0].length);

/** Region zu einem Ort („85049 Ingolstadt“, „Esslingen am Neckar“, „Kirchheim unter Teck“ …). */
export function guessRegion(city: string | null | undefined): string | null {
  if (!city?.trim()) return null;
  const c = norm(city);
  const plz = /\b(\d{5})\b/.exec(c)?.[1];
  const name = c.replace(/\b\d{5}\b/, '').trim();
  for (const [t, r] of TOWNS) {
    if (name === t || name.startsWith(`${t} `) || name.startsWith(`${t}-`) || name.startsWith(`${t},`))
      return r;
  }
  if (plz) for (const [p, r] of PLZ) if (plz.startsWith(p)) return r;
  return null;
}

/** Eingetragene Region, sonst aus dem Ort erkannt. */
export const regionOf = (p: { region?: string | null; city: string | null }) =>
  p.region?.trim() || guessRegion(p.city);
