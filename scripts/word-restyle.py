"""Word-Vorlagen auf die Gestaltung „edel“ umstellen (Schrift Inter, Farben, Tabellen).

Aufruf: python3 -I scripts/word-restyle.py <Eingabe-Ordner> <Ausgabe-Ordner> [--rename]
Inhalt, Platzhalter und Aufbau bleiben unverändert – geändert werden nur Schrift, Größen, Farben, Flächen, Linien.
"""
import os
import re
import sys
import uuid
import zipfile

FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'fonts', 'inter')
KEEP_FONTS = {'Symbol', 'Wingdings', 'Wingdings 2', 'Wingdings 3', 'Webdings', 'MS Gothic', 'Segoe UI Symbol'}

# Farben (Rechnung „edel“): Bordeaux, dunkles Bordeaux, Text, Grau
COLOR_MAP = {
    '8B2332': '7D1435', '8B2333': '7D1435', '7D1435': '7D1435',
    '2E74B5': '7D1435', '1F4D78': '1A171A', '2F5496': '7D1435', '1F3763': '1A171A', '4472C4': '7D1435',
    '0563C1': '7D1435',
    '9A9A9A': '787378', '6E6E6E': '787378', '595959': '403A40', '7F7F7F': '787378', '808080': '787378',
    '000000': '1A171A',
}
FILL_MAP = {
    'F2F2F2': 'F7F6F7', 'F5F5F5': 'F7F6F7', 'D9D9D9': 'EFEDEF', 'E7E6E6': 'F7F6F7',
    'FDFAF2': 'FFFFFF',  # gelbliche Eingabefelder → weiß mit feiner Linie
    'F3E3E6': 'F9F1F4', 'EDE3E5': 'F9F1F4',
    '8B2332': '7D1435',
}
BORDER_COLOR = 'D8D5D8'


def scale_sz(m):
    v = int(m.group(2))
    # Inter läuft etwas breiter als Arial: Fließtext/Tabellen ~5 % kleiner, Überschriften bleiben
    if v <= 22:
        v = max(12, round(v * 0.95))
    return f'{m.group(1)}"{v}"'


def fix_rfonts(m):
    tag = m.group(0)
    names = re.findall(r'w:(?:ascii|hAnsi|cs|eastAsia)="([^"]+)"', tag)
    if any(n in KEEP_FONTS for n in names):
        return tag
    return '<w:rFonts w:ascii="Inter" w:hAnsi="Inter" w:cs="Inter" w:eastAsia="Inter"/>'


def restyle_xml(x, part):
    x = re.sub(r'<w:rFonts\b[^>]*/>', fix_rfonts, x)
    x = re.sub(r'(<w:(?:sz|szCs) w:val=)"(\d+)"', scale_sz, x)
    x = re.sub(r'(<w:color w:val=")([0-9A-Fa-f]{6})(")',
               lambda m: m.group(1) + COLOR_MAP.get(m.group(2).upper(), m.group(2)) + m.group(3), x)
    x = re.sub(r'(w:fill=")([0-9A-Fa-f]{6})(")',
               lambda m: m.group(1) + FILL_MAP.get(m.group(2).upper(), m.group(2)) + m.group(3), x)
    # Tabellen-/Absatzlinien: dünn und hellgrau (Haarlinien), Bordeaux-Linien bleiben Bordeaux
    def border(m):
        tag = m.group(0)
        if 'w:val="nil"' in tag or 'w:val="none"' in tag:
            return tag
        col = re.search(r'w:color="([0-9A-Fa-f]{6}|auto)"', tag)
        is_brand = col and col.group(1).upper() in ('8B2332', '7D1435')
        tag = re.sub(r'w:color="[^"]*"', f'w:color="{"7D1435" if is_brand else BORDER_COLOR}"', tag)
        if 'w:color=' not in tag:
            tag = tag.replace('/>', f' w:color="{BORDER_COLOR}"/>')
        tag = re.sub(r'w:sz="(\d+)"', lambda s: f'w:sz="{min(int(s.group(1)), 8 if is_brand else 4)}"', tag)
        return tag
    x = re.sub(r'<w:(?:top|left|bottom|right|insideH|insideV|start|end)\b[^>]*w:val="[^"]*"[^>]*/>', border, x)
    # Absatzabstände minimal enger (Inter braucht etwas mehr Platz als Arial – Unterschriften bleiben beim Text)
    x = re.sub(r'(w:(?:before|after)=")(\d+)(")', lambda m: f'{m.group(1)}{int(int(m.group(2)) * 0.85)}{m.group(3)}', x)
    # Dokumenttitel (≥ 14 pt) dunkel wie die Nummer auf der Rechnung, Abschnittsüberschriften bleiben Bordeaux
    def title(m):
        rpr = m.group(0)
        sz = re.search(r'<w:sz w:val="(\d+)"', rpr)
        if sz and int(sz.group(1)) >= 28:
            rpr = rpr.replace('w:val="7D1435"', 'w:val="1A171A"')
        return rpr
    x = re.sub(r'<w:rPr>.*?</w:rPr>', title, x, flags=re.S)
    if part == 'word/styles.xml':
        # Standardschrift Inter, Text dunkel, Zeilenabstand etwas luftiger
        x = re.sub(r'<w:rPrDefault>.*?</w:rPrDefault>',
                   '<w:rPrDefault><w:rPr><w:rFonts w:ascii="Inter" w:hAnsi="Inter" w:cs="Inter" w:eastAsia="Inter"/>'
                   '<w:color w:val="1A171A"/><w:sz w:val="17"/><w:szCs w:val="17"/><w:lang w:val="de-DE"/>'
                   '</w:rPr></w:rPrDefault>', x, flags=re.S)
        if '<w:rPrDefault>' not in x:
            x = x.replace('<w:docDefaults>', '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Inter" '
                          'w:hAnsi="Inter" w:cs="Inter" w:eastAsia="Inter"/><w:color w:val="1A171A"/></w:rPr>'
                          '</w:rPrDefault>', 1)
    return x


def obfuscate(data: bytes, guid: str) -> bytes:
    key = bytes.fromhex(guid.replace('-', ''))[::-1]
    b = bytearray(data)
    for i in range(32):
        b[i] ^= key[i % 16]
    return bytes(b)


def embed_fonts(files):
    """Inter Regular + SemiBold (als fett) in die .docx einbetten (Word: Datei → Optionen → Schriftarten einbetten)."""
    fonts = {'embedRegular': 'Inter-Regular.ttf', 'embedBold': 'Inter-SemiBold.ttf'}
    rels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">']
    embeds = []
    for i, (kind, fn) in enumerate(fonts.items(), 1):
        g = str(uuid.uuid5(uuid.NAMESPACE_URL, f'viva-inter-{fn}')).upper()
        data = open(os.path.join(FONT_DIR, fn), 'rb').read()
        files[f'word/fonts/font{i}.odttf'] = obfuscate(data, g)
        rels.append(f'<Relationship Id="rIdF{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
                    f'relationships/font" Target="fonts/font{i}.odttf"/>')
        embeds.append(f'<w:{kind} r:id="rIdF{i}" w:fontKey="{{{g}}}"/>')
    rels.append('</Relationships>')
    files['word/_rels/fontTable.xml.rels'] = '\n'.join(rels).encode()
    ft = files['word/fontTable.xml'].decode('utf8')
    if 'xmlns:r=' not in ft[:2000]:
        ft = ft.replace('<w:fonts ', '<w:fonts xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/'
                        'relationships" ', 1)
    ft = re.sub(r'<w:font w:name="Inter">.*?</w:font>', '', ft, flags=re.S)
    ft = ft.replace('</w:fonts>', '<w:font w:name="Inter"><w:panose1 w:val="020B0502030000000004"/>'
                    '<w:charset w:val="00"/><w:family w:val="swiss"/><w:pitch w:val="variable"/>'
                    + ''.join(embeds) + '</w:font></w:fonts>')
    files['word/fontTable.xml'] = ft.encode()
    st = files['word/settings.xml'].decode('utf8')
    if '<w:embedTrueTypeFonts' not in st:
        st = re.sub(r'(<w:settings\b[^>]*>)', r'\1<w:embedTrueTypeFonts/>', st, count=1)
    files['word/settings.xml'] = st.encode()
    ct = files['[Content_Types].xml'].decode('utf8')
    if 'Extension="odttf"' not in ct:
        ct = ct.replace('<Types ', '<Types ', 1).replace(
            '</Types>', '<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.'
                        'obfuscatedFont"/></Types>')
    files['[Content_Types].xml'] = ct.encode()


def new_name(fn: str) -> str:
    base, ext = os.path.splitext(fn)
    m = re.match(r'^(VD-[A-Za-z0-9-]+?)(_.+)?$', base)
    if not m:
        return fn
    code, rest = m.group(1), m.group(2) or ''
    code = re.sub(r'-V\d+$', '', code) + '-V4'
    return code + rest + ext


def restyle_docx(src: str, dst: str):
    z = zipfile.ZipFile(src)
    files = {n: z.read(n) for n in z.namelist()}
    order = z.namelist()
    for n in list(files):
        if n.startswith('word/') and n.endswith('.xml') and not n.startswith('word/theme'):
            files[n] = restyle_xml(files[n].decode('utf8'), n).encode('utf8')
        if n == 'word/theme/theme1.xml':
            t = files[n].decode('utf8')
            t = re.sub(r'(<a:(?:majorFont|minorFont)>\s*<a:latin typeface=")[^"]*', r'\1Inter', t)
            files[n] = t.encode('utf8')
    embed_fonts(files)
    names = order + [n for n in files if n not in order]
    with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as out:
        for n in names:
            out.writestr(n, files[n])


def main():
    src, dst = sys.argv[1], sys.argv[2]
    rename = '--rename' in sys.argv
    n = 0
    for root, _, fns in os.walk(src):
        for fn in fns:
            if fn.startswith('._') or fn == '.DS_Store':
                continue
            rel = os.path.relpath(os.path.join(root, fn), src)
            target_rel = os.path.join(os.path.dirname(rel), new_name(fn) if rename and fn.endswith('.docx') else fn)
            target = os.path.join(dst, target_rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            if fn.lower().endswith('.docx') and zipfile.is_zipfile(os.path.join(root, fn)):
                restyle_docx(os.path.join(root, fn), target)
                n += 1
            else:
                with open(os.path.join(root, fn), 'rb') as a, open(target, 'wb') as b:
                    b.write(a.read())
    print('umgestellt:', n)


main()
