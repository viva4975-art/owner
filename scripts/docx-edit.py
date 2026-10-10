"""Kleine Bibliothek zum Ändern von Texten in .docx (Absatz-Ebene, Formatierung bleibt). Genutzt für Word-Vorlagen V5.

Verwendung:
    from docxedit import Docx
    d = Docx('in.docx')
    d.replace('alter Text', 'neuer Text')          # auch über mehrere Word-Läufe hinweg; Fehler, wenn nicht gefunden
    d.replace_all('Fortytools', 'Viva-Deluxe-App')  # alle Vorkommen (0 erlaubt), gibt Anzahl zurück
    d.set_para('Anfang des Absatzes', 'ganz neuer Absatztext')
    d.delete_para('Text im Absatz')                 # löscht den ganzen Absatz (in Tabellenzellen: leert ihn)
    d.delete_row('Text in Tabellenzeile')           # löscht die ganze Tabellenzeile
    d.insert_after('Text im Absatz', 'neuer Absatz', bold=None)  # neuer Absatz mit gleicher Formatierung danach
    d.paras()                                       # Liste der Absatztexte (zum Nachsehen)
    d.save('out.docx')

Alle Funktionen arbeiten auf word/document.xml (Kopf-/Fußzeilen: part='word/header1.xml' usw.).
Gesucht wird im zusammengesetzten Text eines Absatzes (ohne Formatierung). Mehrfache Leerzeichen zählen.
"""
import html
import re
import zipfile

P_RE = re.compile(r'<w:p(?=[ >])(?:(?!<w:p[ >]).)*?</w:p>', re.S)
T_RE = re.compile(r'(<w:t(?:\s[^>]*)?>)(.*?)(</w:t>)', re.S)
TR_RE = re.compile(r'<w:tr(?=[ >])(?:(?!<w:tr[ >]).)*?</w:tr>', re.S)


def _unesc(s):
    return html.unescape(s)


def _esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


class NotFound(Exception):
    pass


class Docx:
    def __init__(self, path):
        z = zipfile.ZipFile(path)
        self.order = z.namelist()
        self.files = {n: z.read(n) for n in self.order}
        self.path = path

    def _get(self, part):
        return self.files[part].decode('utf8')

    def _put(self, part, x):
        self.files[part] = x.encode('utf8')

    @staticmethod
    def _ptext(p):
        return ''.join(_unesc(m.group(2)) for m in T_RE.finditer(p))

    def paras(self, part='word/document.xml'):
        return [self._ptext(m.group(0)) for m in P_RE.finditer(self._get(part))]

    def text(self, part='word/document.xml'):
        return '\n'.join(self.paras(part))

    def _replace_in_para(self, p, old, new):
        nodes = list(T_RE.finditer(p))
        texts = [_unesc(m.group(2)) for m in nodes]
        joined = ''.join(texts)
        i = joined.find(old)
        if i < 0:
            return None
        j = i + len(old)
        # Knoten-Grenzen
        pos = 0
        bounds = []
        for t in texts:
            bounds.append((pos, pos + len(t)))
            pos += len(t)
        si = next(k for k, (a, b) in enumerate(bounds) if a <= i < b or (a == b == i))
        ei = next(k for k, (a, b) in enumerate(bounds) if a < j <= b) if j > i else si
        newt = list(texts)
        a0 = bounds[si][0]
        if si == ei:
            t = texts[si]
            newt[si] = t[: i - a0] + new + t[j - a0:]
        else:
            newt[si] = texts[si][: i - a0] + new
            for k in range(si + 1, ei):
                newt[k] = ''
            newt[ei] = texts[ei][j - bounds[ei][0]:]
        out = []
        last = 0
        for k, m in enumerate(nodes):
            out.append(p[last:m.start()])
            open_tag = m.group(1)
            if newt[k] != texts[k] and 'xml:space' not in open_tag:
                open_tag = open_tag[:-1] + ' xml:space="preserve">'
            out.append(open_tag + _esc(newt[k]) + m.group(3))
            last = m.end()
        out.append(p[last:])
        return ''.join(out)

    def replace(self, old, new, part='word/document.xml', count=1):
        """Ersetzt `count` Vorkommen (Standard 1); Fehler, wenn weniger gefunden."""
        x = self._get(part)
        done = 0
        while done < count:
            hit = False
            for m in P_RE.finditer(x):
                r = self._replace_in_para(m.group(0), old, new)
                if r is not None:
                    x = x[: m.start()] + r + x[m.end():]
                    hit = True
                    done += 1
                    break
            if not hit:
                break
        if done < count:
            raise NotFound(f'{self.path}: „{old[:80]}“ nicht gefunden ({done}/{count})')
        self._put(part, x)
        return done

    def replace_all(self, old, new, parts=None):
        parts = parts or [p for p in self.files if re.match(r'word/(document|header\d*|footer\d*)\.xml$', p)]
        n = 0
        for part in parts:
            x = self._get(part)
            while True:
                hit = False
                for m in P_RE.finditer(x):
                    if old in self._ptext(m.group(0)):
                        r = self._replace_in_para(m.group(0), old, new)
                        if r is not None and r != m.group(0):
                            x = x[: m.start()] + r + x[m.end():]
                            hit = True
                            n += 1
                            break
                if not hit or old in new:
                    break
            self._put(part, x)
        return n

    def _find_para(self, contains, part, nth=0):
        x = self._get(part)
        hits = [m for m in P_RE.finditer(x) if contains in self._ptext(m.group(0))]
        if len(hits) <= nth:
            raise NotFound(f'{self.path}: Absatz mit „{contains[:80]}“ nicht gefunden')
        return x, hits[nth]

    def set_para(self, contains, newtext, part='word/document.xml', nth=0):
        x, m = self._find_para(contains, part, nth)
        p = m.group(0)
        nodes = list(T_RE.finditer(p))
        old = ''.join(_unesc(n.group(2)) for n in nodes)
        r = self._replace_in_para(p, old, newtext) if old else None
        if r is None:
            raise NotFound(f'{self.path}: Absatz „{contains}“ ohne Text')
        self._put(part, x[: m.start()] + r + x[m.end():])

    def delete_para(self, contains, part='word/document.xml', nth=0, all=False):
        n = 0
        while True:
            try:
                x, m = self._find_para(contains, part, 0 if all else nth)
            except NotFound:
                if n == 0:
                    raise
                return n
            before = x[: m.start()]
            after = x[m.end():]
            in_cell_alone = re.search(r'(<w:tc>|<w:tc [^>]*>|</w:tcPr>)\s*$', before) and re.match(r'\s*</w:tc>', after)
            if in_cell_alone:
                p = m.group(0)
                p = T_RE.sub(lambda t: t.group(1) + t.group(3), p)
                self._put(part, before + p + after)
            else:
                self._put(part, before + after)
            n += 1
            if not all:
                return n

    def delete_row(self, contains, part='word/document.xml', all=False):
        x = self._get(part)
        n = 0
        while True:
            hits = [m for m in TR_RE.finditer(x) if contains in ''.join(_unesc(t.group(2)) for t in T_RE.finditer(m.group(0)))]
            if not hits:
                break
            m = hits[0]
            x = x[: m.start()] + x[m.end():]
            n += 1
            if not all:
                break
        if not n:
            raise NotFound(f'{self.path}: Tabellenzeile mit „{contains}“ nicht gefunden')
        self._put(part, x)
        return n

    def insert_after(self, contains, text, part='word/document.xml', nth=0, bold=None, like=None):
        """Neuen Absatz nach dem gefundenen einfügen; Formatierung von `like` (Text eines Musterabsatzes) oder vom gefundenen."""
        x, m = self._find_para(contains, part, nth)
        src = m.group(0)
        if like:
            _, lm = self._find_para(like, part)
            src = lm.group(0)
        ppr = re.search(r'<w:pPr>.*?</w:pPr>', src, re.S)
        rpr = None
        for r in re.finditer(r'<w:r(?=[ >]).*?</w:r>', src, re.S):
            if '<w:t' in r.group(0):
                mm = re.search(r'<w:rPr>.*?</w:rPr>', r.group(0), re.S)
                rpr = mm.group(0) if mm else ''
                break
        rpr = rpr or ''
        if bold is True and '<w:b/>' not in rpr:
            rpr = rpr.replace('<w:rPr>', '<w:rPr><w:b/>', 1) if rpr else '<w:rPr><w:b/></w:rPr>'
        if bold is False:
            rpr = re.sub(r'<w:b(Cs)?(/| w:val="[^"]*"/)>', '', rpr)
        runs = []
        for k, line in enumerate(text.split('\n')):
            if k:
                runs.append(f'<w:r>{rpr}<w:br/></w:r>')
            runs.append(f'<w:r>{rpr}<w:t xml:space="preserve">{_esc(line)}</w:t></w:r>')
        newp = '<w:p>' + (ppr.group(0) if ppr else '') + ''.join(runs) + '</w:p>'
        self._put(part, x[: m.end()] + newp + x[m.end():])

    def save(self, path):
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as out:
            for n in self.order:
                out.writestr(n, self.files[n])
