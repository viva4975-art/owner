// Skizzen für die Aushänge im Putzraum (Ahmed 14.10.: „lieber Skizzen als Piktogramme“), im Stil seiner
// Arbeitsanweisungen Reinigungswagen/Waschmaschine: Umriss-Zeichnung, nummerierte Bordeaux-Punkte mit Linie und
// Beschriftung. Die Nummern gehören zu den Schritten des Aushangs (src/pdf/posters.ts).
// Erzeugen: node scripts/aushaenge-skizzen.mjs  →  assets/aushaenge/skizze-<name>.png + .jpg (1600 × 1000)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('../assets/aushaenge/', import.meta.url);
const INTER = readFileSync(new URL('../assets/web/inter-latin.woff2', import.meta.url)).toString('base64');
const INTER_EXT = readFileSync(new URL('../assets/web/inter-latin-ext.woff2', import.meta.url)).toString(
  'base64',
);

const C = {
  ink: '#2c3e50',
  text: '#1f2a37',
  sub: '#4b5563',
  bord: '#8b2332',
  light: '#f3f5f7',
  mid: '#d5dbe1',
  gray: '#9aa5b1',
  dark: '#4a5563',
  red: '#c00000',
  blue: '#2f72b5',
  yellow: '#f2c200',
  green: '#3a8e3a',
  water: '#cfe3f3',
  wood: '#c99a6b',
  floor: '#9aa5b1',
};
const S = `stroke="${C.ink}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"`;
const r = (x, y, w, h, fill = C.light, rx = 0, extra = '') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" ${S} ${extra}/>`;
const c = (x, y, rr, fill = C.light, extra = '') =>
  `<circle cx="${x}" cy="${y}" r="${rr}" fill="${fill}" ${S} ${extra}/>`;
const p = (d, fill = 'none', extra = '') => `<path d="${d}" fill="${fill}" ${S} ${extra}/>`;
const l = (x1, y1, x2, y2, color = C.ink, w = 6, extra = '') =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${w}" stroke-linecap="round" ${extra}/>`;
const t = (x, y, s, size = 26, weight = 700, color = C.text, anchor = 'start') =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${s}</text>`;

/** Nummer mit Linie zum Ziel und Beschriftung (links: Text rechtsbündig vor dem Punkt, rechts: dahinter). */
function mark(n, mx, my, tx, ty, label, sub, side = 'r') {
  const lab =
    side === 'r'
      ? t(mx + 40, my - 4, label) + (sub ? t(mx + 40, my + 26, sub, 22, 400, C.sub) : '')
      : side === 'l'
        ? t(mx - 40, my - 4, label, 26, 700, C.text, 'end') +
          (sub ? t(mx - 40, my + 26, sub, 22, 400, C.sub, 'end') : '')
        : side === 'u'
          ? t(mx, my - 62, label, 26, 700, C.text, 'middle') +
            (sub ? t(mx, my - 34, sub, 22, 400, C.sub, 'middle') : '')
          : t(mx, my + 62, label, 26, 700, C.text, 'middle') +
            (sub ? t(mx, my + 90, sub, 22, 400, C.sub, 'middle') : '');
  return (
    l(mx, my, tx, ty, C.bord, 3) +
    `<circle cx="${tx}" cy="${ty}" r="6" fill="${C.bord}"/>` +
    `<circle cx="${mx}" cy="${my}" r="26" fill="${C.bord}"/>` +
    t(mx, my + 9, String(n), 26, 700, '#fff', 'middle') +
    lab
  );
}
/**
 * Zeichnung (Szenen-Koordinaten, Rahmen bbox) mittig in den Bereich x 380–1220 einpassen, Nummern links (x 330) bzw.
 * rechts (x 1270) in festen Spalten; Ziele in Szenen-Koordinaten. marks: [n, Seite l|r, y Nummer, Ziel x, Ziel y, Text, Unterzeile]
 */
function scene(bbox, body, marks) {
  const [x0, y0, x1, y1] = bbox;
  const k = Math.min(840 / (x1 - x0), 880 / (y1 - y0));
  const ox = 800 - ((x0 + x1) / 2) * k;
  const oy = 515 - ((y0 + y1) / 2) * k;
  const T = (x, y) => [ox + x * k, oy + y * k];
  return (
    `<g transform="translate(${ox} ${oy}) scale(${k})">${body}</g>` +
    marks
      .map(([n, side, my, tx, ty, label, sub]) => {
        const [X, Y] = T(tx, ty);
        return mark(n, side === 'l' ? 330 : 1270, my, X, Y, label, sub, side);
      })
      .join('')
  );
}
const floorLine = (y = 905) => l(100, y, 1500, y, C.gray, 4);

// kleine Bausteine
const bucket = (x, y, w, h, fill) => p(`M${x} ${y}h${w}l-${w * 0.08} ${h}h-${w * 0.84}z`, fill);
const bottle = (x, y, fill, w = 56, h = 120) =>
  r(x, y + 30, w, h - 30, fill, 12) +
  r(x + w * 0.3, y + 8, w * 0.4, 24, C.ink, 3) +
  r(x + 8, y + 62, w - 16, 34, '#fff', 3);
const spray = (x, y, fill) =>
  r(x, y + 34, 54, 100, fill, 12) +
  p(`M${x + 12} ${y + 34}v-26h30l22 14h-22v12`, C.ink) +
  r(x + 8, y + 66, 38, 32, '#fff', 3);
const cloth = (x, y, w, fill) => r(x, y, w, 26, fill, 6) + r(x, y + 26, w, 26, fill, 6);
const hand = (x, y, s = 1, fill = '#f1d3b8', glove = false) => {
  const g = (d) => `<g transform="translate(${x} ${y}) scale(${s})">${d}</g>`;
  const f = glove ? C.blue : fill;
  return g(
    r(-70, -10, 140, 150, f, 46) +
      r(-66, -110, 30, 120, f, 15) +
      r(-30, -136, 30, 146, f, 15) +
      r(6, -128, 30, 138, f, 15) +
      r(42, -96, 28, 106, f, 14) +
      `<rect x="-112" y="-10" width="30" height="96" rx="15" fill="${f}" ${S} transform="rotate(-38 -97 38)"/>` +
      (glove ? r(-74, 120, 148, 44, '#255d95', 10) : ''),
  );
};

const SK = {};

// 1 Farbsystem: vier Bereiche
SK.farbsystem = () => {
  const panel = (i, color, title, sub, draw) => {
    const x = 40 + i * 385;
    return (
      r(x, 120, 365, 800, '#fff', 18) +
      `<rect x="${x + 3}" y="123" width="359" height="96" rx="15" fill="${color}"/>` +
      `<circle cx="${x + 52}" cy="171" r="28" fill="#fff"/>` +
      t(x + 52, 181, String(i + 1), 30, 800, color, 'middle') +
      t(x + 96, 165, title, 30, 800, i === 1 ? C.text : '#fff') +
      t(x + 96, 200, sub, 21, 500, i === 1 ? C.text : '#fff') +
      draw(x) +
      // Tuch und Eimer in der Farbe
      bucket(x + 50, 760, 120, 120, color) +
      cloth(x + 210, 820, 110, color)
    );
  };
  return (
    panel(
      0,
      C.red,
      'Rot',
      'WC und Urinal',
      (x) =>
        // Urinal an der Wand + WC
        r(x + 40, 280, 110, 170, '#fff', 40) +
        p(`M${x + 60} ${400}q35 40 70 0`) +
        l(x + 95, 260, x + 95, 280) +
        p(`M${x + 200} ${560}h120v-40h-120z`, '#fff') +
        p(`M${x + 205} ${560}q0 100 60 110v50h40v-60q20-30 20-100z`, '#fff') +
        r(x + 290, 420, 50, 100, '#fff', 10),
    ) +
    panel(
      1,
      C.yellow,
      'Gelb',
      'Sanitär: Becken, Fliesen',
      (x) =>
        r(x + 100, 260, 170, 200, C.water, 10) +
        l(x + 130, 300, x + 170, 340, '#fff', 8) +
        p(`M${x + 70} 560h230q0 90-115 90t-115-90z`, '#fff') +
        p(`M${x + 185} 560v-45h40`, 'none') +
        l(x + 185, 650, x + 185, 720),
    ) +
    panel(
      2,
      C.blue,
      'Blau',
      'Büro und Möbel',
      (x) =>
        r(x + 30, 560, 300, 30, C.wood, 4) +
        l(x + 50, 590, x + 50, 720) +
        l(x + 310, 590, x + 310, 720) +
        r(x + 130, 400, 150, 100, C.dark, 8) +
        l(x + 205, 500, x + 205, 560) +
        r(x + 60, 620, 90, 20, C.blue, 4) +
        l(x + 105, 640, x + 105, 720),
    ) +
    panel(
      3,
      C.green,
      'Grün',
      'Küche, Lebensmittel',
      (x) =>
        r(x + 30, 540, 300, 180, '#fff', 6) +
        l(x + 180, 540, x + 180, 720) +
        r(x + 30, 520, 300, 24, C.mid, 4) +
        p(`M${x + 70} 520v-60h40`) +
        p(`M${x + 210} 520l10-70h70l10 70z`, C.light) +
        p(`M${x + 300} 470q30 0 30 30t-30 30`) +
        r(x + 60, 290, 240, 130, '#fff', 6) +
        l(x + 180, 290, x + 180, 420),
    )
  );
};

// 2 Hautschutz: vier Hände
SK.hautschutz = () => {
  const panel = (i, title, sub, draw) => {
    const x = 40 + i * 385;
    return (
      r(x, 120, 365, 800, '#fff', 18) +
      `<circle cx="${x + 52}" cy="180" r="28" fill="${C.bord}"/>` +
      t(x + 52, 190, String(i + 1), 30, 800, '#fff', 'middle') +
      t(x + 96, 174, title, 28, 800) +
      t(x + 96, 206, sub, 21, 500, C.sub) +
      draw(x)
    );
  };
  return (
    panel(
      0,
      'Hautschutz',
      'vor der Arbeit',
      (x) =>
        hand(x + 180, 560, 1.15) +
        r(x + 220, 330, 70, 150, '#fff', 12) +
        r(x + 235, 300, 40, 34, C.bord, 6) +
        `<circle cx="${x + 180}" cy="520" r="18" fill="#fff" ${S}/>` +
        t(x + 182, 820, 'Creme einmassieren', 24, 600, C.sub, 'middle'),
    ) +
    panel(
      1,
      'Handschuhe',
      'bei Nassarbeit',
      (x) =>
        hand(x + 180, 560, 1.15, '', true) + t(x + 182, 820, 'Schutzhandschuhe', 24, 600, C.sub, 'middle'),
    ) +
    panel(
      2,
      'Hände reinigen',
      'Pause, Feierabend',
      (x) =>
        p(`M${x + 90} 300h150q30 0 30 30v30`, 'none') +
        r(x + 70, 280, 40, 50, C.mid, 6) +
        [0, 1, 2]
          .map((k) => `<circle cx="${x + 270}" cy="${400 + k * 40}" r="9" fill="${C.blue}"/>`)
          .join('') +
        hand(x + 200, 640, 1) +
        t(x + 182, 820, 'mild waschen, abtrocknen', 24, 600, C.sub, 'middle'),
    ) +
    panel(
      3,
      'Hände pflegen',
      'nach der Arbeit',
      (x) =>
        hand(x + 180, 600, 1.15) +
        p(`M${x + 180} 330c22 30 34 50 34 66a34 34 0 0 1-68 0c0-16 12-36 34-66z`, C.water) +
        t(x + 182, 820, 'eincremen', 24, 600, C.sub, 'middle'),
    )
  );
};

// 3 Sanitärraum
SK.sanitaer = () =>
  scene(
    [300, 110, 1340, 910],
    // Wand + Fliesen
    r(300, 120, 1000, 785, '#f8fafc', 0, 'stroke-width="4"') +
      [0, 1, 2, 3, 4].map((k) => l(300, 200 + k * 80, 1300, 200 + k * 80, C.mid, 2)).join('') +
      floorLine() +
      // Abfalleimer
      r(330, 720, 110, 180, C.dark, 10) +
      r(320, 700, 130, 26, C.ink, 6) +
      // Spender
      r(480, 330, 80, 120, '#fff', 10) +
      r(500, 450, 40, 16, C.ink, 4) +
      r(590, 300, 120, 150, '#fff', 10) +
      l(610, 430, 690, 430, C.gray, 6) +
      // Spiegel + Becken
      r(760, 240, 220, 200, C.water, 8) +
      l(800, 280, 850, 330, '#fff', 8) +
      p('M740 560h260q0 90-130 90t-130-90z', '#fff') +
      p('M870 560v-50h40', 'none') +
      l(870, 650, 870, 900) +
      // WC-Kabine
      r(1040, 260, 230, 645, '#fff', 0) +
      p('M1080 760h130v-40h-130z', '#fff') +
      p('M1086 760q0 80 50 90v45h40v-55q20-25 20-80z', '#fff') +
      r(1170, 600, 50, 120, '#fff', 10) +
      // Tür + Lichtschalter
      r(1320, 300, 0, 0) +
      // Wischspur
      `<path d="M1200 870 C 1000 860, 900 880, 760 870 S 500 860, 460 880" fill="none" stroke="${C.blue}" stroke-width="6" stroke-dasharray="18 14"/>` +
      `<path d="M470 866l-26 16 26 14" fill="none" stroke="${C.blue}" stroke-width="6"/>` +
      r(1300, 420, 34, 50, '#fff', 6),
    [
      [1, 'l', 820, 385, 780, 'Abfall', 'leeren, neuer Beutel'],
      [2, 'l', 330, 560, 370, 'Auffüllen', 'Seife, Papier'],
      [3, 'l', 520, 860, 300, 'Spiegel + Becken', 'gelbes Tuch'],
      [6, 'r', 330, 1317, 445, 'Kontrolle', 'dann Licht aus'],
      [4, 'r', 600, 1150, 760, 'WC zuletzt', 'rotes Tuch, Bürste'],
      [5, 'r', 860, 1000, 870, 'Boden', 'von hinten zur Tür'],
    ],
  );

// 4 Bodenreinigung (Draufsicht)
SK.boden = () =>
  scene(
    [50, 110, 1360, 910],
    r(300, 120, 900, 760, '#fff', 4) +
      // Tür unten rechts
      `<rect x="1000" y="872" width="150" height="16" fill="#fff"/>` +
      p('M1000 880a150 150 0 0 1 150-150', 'none', 'stroke-width="3" stroke-dasharray="10 8"') +
      // Möbel
      r(360, 180, 260, 140, C.wood, 6) +
      r(980, 180, 160, 260, C.mid, 6) +
      // Schlangenlinie von hinten nach vorn zur Tür
      `<path d="M380 380 Q 520 340 660 380 T 940 380 T 1140 420 M1140 420 Q 1000 480 860 460 T 560 500 T 360 540 M360 540 Q 520 580 680 560 T 980 600 T 1140 640 M1140 640 Q 1000 700 860 690 T 600 720 T 420 760 M420 760 Q 700 800 1070 840" fill="none" stroke="${C.blue}" stroke-width="7" stroke-dasharray="20 14"/>` +
      `<path d="M1050 822l30 20-34 12" fill="none" stroke="${C.blue}" stroke-width="7"/>` +
      // Ecken markiert
      [
        [300, 120],
        [1200, 120],
        [300, 880],
      ]
        .map(
          ([x, y]) =>
            `<circle cx="${x}" cy="${y}" r="34" fill="none" stroke="${C.yellow}" stroke-width="8"/>`,
        )
        .join('') +
      // Warnschild an der Tür (außen)
      p('M1250 900l50-110 50 110z', C.yellow) +
      t(1300, 885, '!', 52, 900, C.text, 'middle') +
      // Besen / Krümel
      [0, 1, 2, 3, 4]
        .map((k) => `<circle cx="${700 + k * 26}" cy="${240 + (k % 2) * 18}" r="6" fill="${C.dark}"/>`)
        .join('') +
      l(820, 200, 760, 280, C.wood, 10) +
      p('M740 270l40 30 30-40-40-20z', C.dark) +
      // Wagen mit Eimer und Mopp
      r(60, 640, 180, 90, C.bord, 10) +
      bucket(80, 560, 70, 80, C.blue) +
      bucket(160, 560, 70, 80, C.red) +
      c(90, 745, 16, C.ink) +
      c(210, 745, 16, C.ink) +
      // neuer Mopp + Wäschesack
      r(60, 300, 150, 40, C.blue, 8) +
      r(60, 350, 150, 40, C.blue, 8) +
      p('M70 430h130l-10 120h-110z', '#e5d3bd'),
    [
      [6, 'l', 250, 135, 300, 'Mopp wechseln', 'je Raum frisch'],
      [3, 'l', 700, 150, 640, 'Mopp vorbereiten', 'Reiniger dosieren'],
      [2, 'r', 150, 760, 250, 'Grobschmutz', 'kehren / saugen'],
      [5, 'r', 330, 1200, 120, 'Ecken + Kanten', 'nicht vergessen'],
      [4, 'r', 560, 1140, 520, 'Schlangenlinien', 'rückwärts zur Tür'],
      [1, 'r', 860, 1300, 845, 'Warnschild', 'am Eingang'],
    ],
  );

// 5 Scheuersaugmaschine (Seitenansicht)
SK.scheuersaug = () =>
  scene(
    [290, 170, 1310, 890],
    floorLine(860) +
      // Körper
      p('M520 440h460q40 0 40 40v300h-560v-300q0-40 60-40z', C.light) +
      // Schmutzwassertank (oben, Deckel offen)
      r(560, 360, 400, 90, C.dark, 14) +
      p('M560 360l40-80h300', 'none') +
      r(600, 270, 300, 26, C.gray, 8, 'transform="rotate(-12 600 283)"') +
      // Frischwassertank Einfüllöffnung
      r(860, 470, 90, 40, C.blue, 10) +
      l(905, 470, 905, 440, C.blue, 8) +
      // Akku im Inneren
      r(600, 560, 220, 130, C.yellow, 8) +
      t(710, 640, 'AKKU', 30, 800, C.text, 'middle') +
      // Bürstenkopf vorn
      r(860, 780, 200, 50, C.ink, 10) +
      [0, 1, 2, 3, 4, 5, 6, 7].map((k) => l(872 + k * 24, 830, 872 + k * 24, 858, C.red, 6)).join('') +
      // Räder + Saugfuß hinten
      c(560, 810, 46, C.dark) +
      c(560, 810, 16, '#fff') +
      p('M380 840h150', 'none', `stroke="${C.ink}" stroke-width="14"`) +
      l(380, 855, 530, 855, '#111', 6) +
      l(455, 840, 520, 780) +
      // Schlauch Schmutzwasser
      p('M520 700q-80 0-80 70v50', 'none', `stroke="${C.gray}" stroke-width="16"`) +
      r(424, 816, 34, 30, C.gray, 6) +
      // Lenker + Bedienfeld
      l(520, 470, 380, 230, C.ink, 14) +
      r(300, 180, 180, 80, C.dark, 12) +
      `<circle cx="345" cy="220" r="14" fill="${C.green}"/>` +
      `<circle cx="395" cy="220" r="14" fill="${C.red}"/>` +
      r(420, 205, 40, 30, C.water, 4) +
      // Ladekabel zur Steckdose
      p('M820 640q120 30 260 -20t150 -40', 'none', `stroke="${C.ink}" stroke-width="7"`) +
      r(1230, 540, 70, 90, '#fff', 10) +
      `<circle cx="1252" cy="585" r="7" fill="${C.ink}"/><circle cx="1278" cy="585" r="7" fill="${C.ink}"/>` +
      // ausgebaute Bürste zum Reinigen
      r(1120, 820, 160, 40, C.ink, 10) +
      [0, 1, 2, 3, 4, 5].map((k) => l(1132 + k * 26, 860, 1132 + k * 26, 884, C.red, 6)).join(''),
    [
      [4, 'l', 200, 330, 240, 'Bedienfeld', 'langsam in Bahnen'],
      [5, 'l', 560, 440, 780, 'Schmutzwasser', 'im Ausguss ablassen'],
      [3, 'l', 840, 400, 845, 'Saugfuß', 'Gummilippen prüfen'],
      [6, 'r', 120, 760, 290, 'Tanks ausspülen', 'Deckel offen lassen'],
      [1, 'r', 300, 905, 470, 'Frischwasser', 'Reiniger nach Hersteller'],
      [8, 'r', 480, 1290, 560, 'Akku laden', 'belüfteter Raum'],
      [2, 'r', 680, 1020, 800, 'Bürste / Pad', 'prüfen, einsetzen'],
      [7, 'r', 870, 1200, 860, 'Reinigen', 'Bürste + Saugfuß'],
    ],
  );

// 6 Mopps & Tücher waschen
SK.waesche = () =>
  scene(
    [100, 100, 1490, 910],
    floorLine() +
      // drei Sortierkörbe
      [C.red, C.blue, C.green]
        .map((col, k) => bucket(120 + k * 120, 780, 100, 120, col) + r(130 + k * 120, 760, 80, 28, '#fff', 8))
        .join('') +
      // Mopp ausschütteln
      l(480, 420, 560, 700, C.wood, 12) +
      r(500, 700, 140, 46, C.blue, 10) +
      [0, 1, 2]
        .map((k) => p(`M${520 + k * 40} 770q10 20 0 40`, 'none', `stroke="${C.gray}" stroke-width="4"`))
        .join('') +
      // Waschmaschine
      r(700, 380, 360, 520, '#f8fafc', 18) +
      l(700, 470, 1060, 470) +
      r(730, 405, 110, 44, C.mid, 6) +
      r(870, 405, 100, 44, '#1f4e79', 6) +
      t(920, 437, '60°', 28, 800, '#a5e3a5', 'middle') +
      c(1010, 427, 22, '#fff') +
      c(880, 670, 140, C.mid) +
      c(880, 670, 100, '#cbd5e1') +
      // Waschmittel
      bottle(1110, 760, C.blue, 70, 140) +
      // Wäscheständer
      l(1260, 900, 1330, 560) +
      l(1470, 900, 1400, 560) +
      l(1300, 620, 1440, 620, C.ink, 5) +
      [0, 1, 2].map((k) => r(1300 + k * 48, 620, 40, 70, [C.yellow, C.blue, C.red][k], 4)).join('') +
      // Regal mit sauberer Wäsche
      r(1180, 160, 300, 18, C.wood, 4) +
      r(1180, 280, 300, 18, C.wood, 4) +
      cloth(1210, 108, 110, C.blue) +
      cloth(1340, 108, 110, C.green) +
      cloth(1210, 228, 110, C.yellow),
    [
      [2, 'l', 330, 520, 560, 'Ausschütteln', 'grob reinigen'],
      [1, 'l', 820, 160, 790, 'Sortieren', 'nach Farben'],
      [4, 'l', 120, 920, 420, 'Temperatur', 'nach Pflegeetikett'],
      [7, 'r', 140, 1340, 230, 'Lagern', 'sauber + trocken'],
      [6, 'r', 480, 1420, 650, 'Trocknen', 'sofort raus'],
      [5, 'r', 700, 1150, 800, 'Waschmittel', 'nach Hersteller'],
      [3, 'r', 900, 880, 790, 'Beladen', 'max. drei Viertel'],
    ],
  );

// 7 Ordnung im Putzraum
SK.putzraum = () =>
  scene(
    [160, 110, 1440, 910],
    r(160, 120, 1280, 785, '#f8fafc', 0, 'stroke-width="4"') +
      floorLine() +
      // Regal
      r(200, 180, 420, 20, C.wood, 4) +
      r(200, 400, 420, 20, C.wood, 4) +
      r(200, 620, 420, 20, C.wood, 4) +
      l(210, 200, 210, 900, C.wood, 10) +
      l(610, 200, 610, 900, C.wood, 10) +
      bottle(240, 290, C.red) +
      bottle(310, 290, C.yellow) +
      bottle(380, 290, C.blue) +
      spray(460, 270, C.green) +
      // Ordner
      r(240, 470, 50, 150, C.bord, 6) +
      r(300, 470, 50, 150, C.dark, 6) +
      t(265, 590, 'SDB', 18, 800, '#fff', 'middle') +
      cloth(400, 560, 160, C.blue) +
      // Wäschesack
      p('M260 740h160l-14 160h-132z', '#e5d3bd') +
      p('M300 780q40 30 80 0', 'none', `stroke="${C.wood}" stroke-width="5"`) +
      // Fenster
      r(700, 200, 260, 200, C.water, 6) +
      l(830, 200, 830, 400, C.ink, 5) +
      p('M960 200l60 40v200l-60-40', '#fff') +
      // Wagen + Ladegerät
      r(700, 760, 300, 30, C.bord, 6) +
      r(720, 560, 140, 200, C.dark, 6) +
      bucket(880, 650, 100, 110, C.blue) +
      c(740, 820, 22, C.ink) +
      c(960, 820, 22, C.ink) +
      r(1040, 640, 140, 260, C.light, 12) +
      r(1060, 670, 100, 50, C.yellow, 6) +
      p('M1180 700q60 0 80-60', 'none', `stroke="${C.ink}" stroke-width="6"`) +
      r(1240, 590, 50, 64, '#fff', 8) +
      // Tür mit Schlüssel
      r(1300, 260, 120, 645, '#fff', 0) +
      `<circle cx="1320" cy="600" r="8" fill="${C.ink}"/>` +
      c(1345, 600, 14, C.yellow) +
      l(1359, 600, 1395, 600, C.yellow, 8),
    [
      [1, 'l', 280, 240, 330, 'Mittel im Regal', 'Original, verschlossen'],
      [6, 'l', 520, 265, 520, 'Unterlagen', 'Ordner + SDB'],
      [3, 'l', 820, 300, 820, 'Wäschesack', 'benutzt getrennt'],
      [5, 'r', 200, 830, 300, 'Lüften', 'nasse Sachen trocknen'],
      [2, 'r', 520, 1360, 600, 'Abschließen', 'immer'],
      [4, 'r', 840, 900, 790, 'Wagen + Maschinen', 'sauber, Akku laden'],
    ],
  );

const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
  <style>@font-face{font-family:Inter;src:url(data:font/woff2;base64,${INTER}) format('woff2');unicode-range:U+0000-00FF}
  @font-face{font-family:Inter;src:url(data:font/woff2;base64,${INTER_EXT}) format('woff2');unicode-range:U+0100-024F,U+2000-206F}
  text{font-family:Inter,sans-serif}</style>
  <rect width="1600" height="1000" fill="#fff"/>${body}</svg>`;

mkdirSync(OUT, { recursive: true });
const only = process.argv[2];
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium',
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
for (const [name, fn] of Object.entries(SK)) {
  if (only && only !== name) continue;
  await page.setContent(`<html><body style="margin:0">${svg(fn())}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  const clip = { x: 0, y: 0, width: 1600, height: 1000 };
  // PNG für die Web-Vorschau, JPEG für die PDFs (pdf-lib bettet JPEG ohne Dekodieren ein → schnell)
  writeFileSync(new URL(`skizze-${name}.png`, OUT), await page.screenshot({ clip }));
  writeFileSync(
    new URL(`skizze-${name}.jpg`, OUT),
    await page.screenshot({ clip, type: 'jpeg', quality: 92 }),
  );
  console.log('skizze', name);
}
await browser.close();
