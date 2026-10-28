import { describe, expect, it } from 'vitest';
import { queuedIds, recentSendJobs, startSendJob } from './send-jobs.js';

describe('Sammelversand im Hintergrund', () => {
  it('läuft weiter, sammelt Fehler und nimmt Wartende nicht doppelt an', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sent: string[] = [];
    const job = startSendJob(
      'Dokumenten',
      ['a', 'b', 'c'],
      async (id) => {
        await gate;
        if (id === 'b') throw new Error('kaputt');
        sent.push(id);
      },
      async (id, e) => `${id}: ${(e as Error).message}`,
    );
    expect(job.running).toBe(true);
    expect(queuedIds()).toEqual(['a', 'b', 'c']);
    const again = startSendJob(
      'Dokumenten',
      ['c', 'd'],
      async (id) => void sent.push(id),
      async () => '',
    );
    expect(again.ids).toEqual(['d']);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(job.running).toBe(false);
    expect(job.ok).toBe(2);
    expect(job.errors).toEqual(['b: kaputt']);
    expect(sent.sort()).toEqual(['a', 'c', 'd']);
    expect(queuedIds()).toEqual([]);
    expect(recentSendJobs()[0]!.id).toBe(again.id);
  });
});
