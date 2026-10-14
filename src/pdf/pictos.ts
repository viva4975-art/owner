/**
 * Piktogramme für Aushänge und den Objektordner (eigene Zeichnungen im 24er-Raster, Strichstil wie die Symbole der App,
 * „hand“, „phone“, „alert“, „trash“ nach Lucide, ISC-Lizenz). Gezeichnet als Vektor (kein Bild) → scharf beim Drucken.
 */
import { LineCapStyle, type PDFPage, type RGB, rgb } from '@cantoo/pdf-lib';

type Prim = string | { dot: [number, number, number] };

const circle = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
const rrect = (x: number, y: number, w: number, h: number, r = 0) =>
  r
    ? `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`
    : `M${x} ${y}h${w}v${h}h${-w}z`;

export const PICTOS = {
  phone: [
    'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z',
  ],
  alert: [
    'M21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3',
    'M12 9v4',
    { dot: [12, 17, 1.1] },
  ],
  cross: [rrect(3, 3, 18, 18, 3), 'M12 7.5v9', 'M7.5 12h9'],
  pin: ['M20 10c0 5-5.5 10.2-7.4 11.8a1 1 0 0 1-1.2 0C9.5 20.2 4 15 4 10a8 8 0 0 1 16 0', circle(12, 10, 3)],
  user: ['M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2', circle(12, 7, 4)],
  house: ['M3 10l9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9 22V12h6v10'],
  exit: ['M14 3h6v18h-6', 'M3 12h11', 'M10 8l4 4-4 4'],
  people: [
    circle(9, 7, 3.5),
    'M2 21v-1.5a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5V21',
    'M16 3.3a3.5 3.5 0 0 1 0 7.4',
    'M22 21v-1.5a5 5 0 0 0-3.5-4.8',
  ],
  hand: [
    'M18 11V6a2 2 0 0 0-4 0v5',
    'M14 10V4a2 2 0 0 0-4 0v2',
    'M10 10.5V6a2 2 0 0 0-4 0v8',
    'M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15',
  ],
  tube: ['M8 5h8l1.5 15a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2z', rrect(9, 2, 6, 3, 1), 'M9 11h6'],
  droplet: ['M12 2.5c3 4 6.5 7.5 6.5 11.5a6.5 6.5 0 0 1-13 0c0-4 3.5-7.5 6.5-11.5z'],
  wash: [
    'M12 2.5c2 2.7 4 5 4 7.5a4 4 0 0 1-8 0c0-2.5 2-4.8 4-7.5z',
    'M4 16c1.5 0 1.5 1.5 3 1.5S8.5 16 10 16s1.5 1.5 3 1.5 1.5-1.5 3-1.5 1.5 1.5 3 1.5 1.5-1.5 2-1.5',
    'M4 20c1.5 0 1.5 1.5 3 1.5S8.5 20 10 20s1.5 1.5 3 1.5 1.5-1.5 3-1.5 1.5 1.5 3 1.5 1.5-1.5 2-1.5',
  ],
  cart: [
    'M2 3h3l2.7 12.4a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 2-1.6L22 7H6',
    circle(9, 20.5, 1.5),
    circle(18, 20.5, 1.5),
  ],
  bucket: ['M4 9h16l-1.8 11a2 2 0 0 1-2 1.7H7.8a2 2 0 0 1-2-1.7z', 'M5 9a7 6.5 0 0 1 14 0'],
  trash: [
    'M3 6h18',
    'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6',
    'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2',
    'M10 11v6',
    'M14 11v6',
  ],
  wipe: [rrect(3, 9, 18, 10, 2), 'M3 13h18', 'M7 5l3 3', 'M12 3l2 5', 'M18 4l-2 4'],
  mop: ['M14 2l-4 13', rrect(4, 15, 14, 3.5, 1), 'M6 18.5v3', 'M9 18.5v3', 'M12 18.5v3', 'M15 18.5v3'],
  bag: ['M5 8h14l-1 13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z', 'M9 8V6a3 3 0 0 1 6 0v2'],
  bottle: ['M10 2h4v3l2 3v13a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V8l2-3z', rrect(8, 11, 8, 6, 0)],
  spray: [
    'M9 10h7v11a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1z',
    'M10 10V7h4v3',
    'M14 7l4-1v3h-3',
    'M20 5l1.5-1',
    'M20.5 8h1.5',
  ],
  lid: [rrect(7, 9, 10, 13, 1.5), rrect(6, 5, 12, 4, 1), 'M10 5V3h4v2'],
  washer: [
    rrect(3, 2, 18, 20, 2.5),
    'M3 7h18',
    circle(12, 14.5, 5),
    'M9 15c1-1 2 1 3 0s2 1 3 0',
    { dot: [7, 4.6, 0.9] },
    { dot: [10, 4.6, 0.9] },
  ],
  thermo: ['M14 4v10.5a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0z', 'M12 13v4', 'M17 6h2', 'M17 9h2'],
  filter: [rrect(4, 4, 16, 16, 2), 'M4 10h16', 'M4 14h16', 'M10 4v16', 'M14 4v16'],
  door: ['M3 21h18', 'M5 21V3h10v18', 'M15 5l4 2v14', { dot: [12, 12, 0.9] }],
  sun: [
    circle(12, 12, 4),
    'M12 2v2',
    'M12 20v2',
    'M2 12h2',
    'M20 12h2',
    'M4.9 4.9l1.4 1.4',
    'M17.7 17.7l1.4 1.4',
    'M4.9 19.1l1.4-1.4',
    'M17.7 6.3l1.4-1.4',
  ],
  air: ['M3 8h10a3 3 0 1 0-3-3', 'M3 12h15a3 3 0 1 1-3 3', 'M3 16h7'],
  book: [
    'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z',
    'M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
    'M8 7h8',
    'M8 11h6',
  ],
  cup: ['M5 8h12v6a6 6 0 0 1-12 0z', 'M17 10h2a2 2 0 0 1 0 4h-2', 'M8 2v3', 'M12 2v3'],
  ladder: ['M7 2v20', 'M17 2v20', 'M7 6h10', 'M7 11h10', 'M7 16h10'],
  check: ['M20 6L9 17l-5-5'],
  x: ['M18 6L6 18', 'M6 6l12 12'],
  mix: ['M6 8h4v13H6z', 'M14 8h4v13h-4z', 'M7 8V5h2v3', 'M15 8V5h2v3', 'M3 3l18 18'],
  palette: [circle(7, 7, 3), circle(17, 7, 3), circle(7, 17, 3), circle(17, 17, 3)],
  clock: [circle(12, 12, 10), 'M12 6v6l4 2'],
  doc: [
    'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z',
    'M14 2v4a2 2 0 0 0 2 2h4',
    'M8 13h8',
    'M8 17h6',
  ],
  key: [circle(7.5, 15.5, 5), 'M11 12l9.5-9.5', 'M17 6l3 3', 'M14.5 8.5l2 2'],
  calendar: [rrect(3, 4, 18, 18, 2), 'M16 2v4', 'M8 2v4', 'M3 10h18'],
} satisfies Record<string, Prim[]>;

export type PictoName = keyof typeof PICTOS;

/**
 * Piktogramm zeichnen. (x, yTop) = linke obere Ecke in Seitenkoordinaten von oben, size = Kantenlänge in pt.
 */
export function drawPicto(
  page: PDFPage,
  name: PictoName,
  x: number,
  yTop: number,
  size: number,
  color: RGB,
  stroke = 2,
) {
  const s = size / 24;
  const y = page.getHeight() - yTop;
  for (const p of PICTOS[name] as Prim[]) {
    if (typeof p === 'string')
      page.drawSvgPath(p, {
        x,
        y,
        scale: s,
        borderColor: color,
        borderWidth: stroke,
        borderLineCap: LineCapStyle.Round,
      });
    else page.drawSvgPath(circle(p.dot[0], p.dot[1], p.dot[2]), { x, y, scale: s, color });
  }
}

/** Piktogramm in einem gefüllten Kreis (wie ein Gebotszeichen): Kreis in `bg`, Symbol in `fg`. */
export function drawPictoBadge(
  page: PDFPage,
  name: PictoName,
  cx: number,
  cyTop: number,
  r: number,
  bg: RGB,
  fg: RGB = rgb(1, 1, 1),
) {
  page.drawCircle({ x: cx, y: page.getHeight() - cyTop, size: r, color: bg });
  const size = r * 1.15;
  drawPicto(page, name, cx - size / 2, cyTop - size / 2, size, fg, 2.2);
}
