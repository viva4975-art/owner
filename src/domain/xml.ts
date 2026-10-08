// xmlbuilder2 lässt Entitäten im Objekt-Format stehen (Fund 07.10.: „Rußbach GmbH &amp; Co.KG“) → beim Lesen auflösen
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unescapeXml = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) =>
    e[0] === '#'
      ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : (ENT[e.toLowerCase()] ?? m),
  );
