import { describe, expect, it } from 'vitest';
import { rejectReason } from './kosit.js';

describe('rejectReason', () => {
  it('nennt den Grund, wenn kein Prüfszenario gegriffen hat', () => {
    const xml =
      '<rep:report xmlns:rep="http://www.xoev.de/de/validator/varl/1"><rep:noScenarioMatched/><rep:assessment><rep:reject><rep:explanation><html><body>' +
      '<p class="important error">Bewertung: Es wird empfohlen das Dokument zurückzuweisen.</p></body></html></rep:explanation></rep:reject></rep:assessment></rep:report>';
    const r = rejectReason({ reportXml: xml, messages: [] });
    expect(r).toContain('kein Prüfszenario');
    expect(r).toContain('zurückzuweisen');
  });
  it('ohne erkennbaren Grund ein Hinweis statt leerer Meldung', () => {
    expect(rejectReason({ reportXml: '<rep:report/>', messages: [] })).toContain('KoSIT-Prüfung');
  });
});
