/*
 * Sammelversand im Hintergrund (Ahmed 28.10.: „Mailversand dauert ewig“). Der Mailserver erlaubt nur wenige Mails
 * je Minute (Drosselung im Mailer) – statt die Seite minutenlang warten zu lassen, läuft der Versand hier weiter und
 * die Seite „Noch nicht versendet“ zeigt den Fortschritt. Nur im Speicher: startet der Server neu, bleiben noch nicht
 * gesendete Dokumente einfach in der Liste (jedes Dokument wird ohnehin genau einmal versendet).
 */

export interface SendJob {
  id: string;
  label: string;
  ids: string[];
  done: number;
  ok: number;
  errors: string[];
  running: boolean;
  startedAt: number;
  finishedAt: number | null;
}

const jobs: SendJob[] = [];
const KEEP_MS = 30 * 60_000;

function prune() {
  const now = Date.now();
  for (let i = jobs.length - 1; i >= 0; i--) {
    const j = jobs[i]!;
    if (!j.running && j.finishedAt && now - j.finishedAt > KEEP_MS) jobs.splice(i, 1);
  }
}

/** Startet den Versand; `run` je Dokument, wirft bei Fehler (Text landet in `errors`). */
export function startSendJob(
  label: string,
  ids: string[],
  run: (id: string) => Promise<void>,
  describe: (id: string, err: unknown) => Promise<string>,
): SendJob {
  prune();
  const queued = new Set(queuedIds());
  const todo = ids.filter((id) => !queued.has(id));
  const job: SendJob = {
    id: crypto.randomUUID(),
    label,
    ids: todo,
    done: 0,
    ok: 0,
    errors: [],
    running: true,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.push(job);
  void (async () => {
    for (const id of todo) {
      try {
        await run(id);
        job.ok++;
      } catch (err) {
        job.errors.push(await describe(id, err).catch(() => `${id}: ${(err as Error).message}`));
      }
      job.done++;
    }
    job.running = false;
    job.finishedAt = Date.now();
  })();
  return job;
}

/** Versandaufträge der letzten 30 Minuten, neueste zuerst */
export function recentSendJobs(): SendJob[] {
  prune();
  return [...jobs].reverse();
}

/** Dokumente, die gerade in einem laufenden Versand noch warten bzw. gesendet werden */
export function queuedIds(): string[] {
  return jobs.filter((j) => j.running).flatMap((j) => j.ids.slice(j.done));
}

export function dismissSendJob(id: string) {
  const i = jobs.findIndex((j) => j.id === id && !j.running);
  if (i >= 0) jobs.splice(i, 1);
}
