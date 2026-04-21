import * as fs from 'fs';
import { sleep, logError, writeToCSV, runConcurrent, retry } from '../utils';

// ─── sleep ───────────────────────────────────────────────────────────────────

describe('sleep', () => {
  it('resolves after roughly the given ms', async () => {
    const start = Date.now();
    await sleep(100);
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
  });
});

// ─── retry ───────────────────────────────────────────────────────────────────

describe('retry', () => {
  it('returns value immediately on first success', async () => {
    const result = await retry(() => Promise.resolve('ok'), 3, 0);
    expect(result).toBe('ok');
  });

  it('retries and succeeds on second attempt', async () => {
    let calls = 0;
    const result = await retry(() => {
      calls++;
      if (calls < 2) return Promise.reject(new Error('fail'));
      return Promise.resolve('recovered');
    }, 3, 0);
    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('throws after all retries are exhausted', async () => {
    let calls = 0;
    await expect(
      retry(() => { calls++; return Promise.reject(new Error('always fails')); }, 3, 0)
    ).rejects.toThrow('always fails');
    expect(calls).toBe(3);
  });
});

// ─── runConcurrent ───────────────────────────────────────────────────────────

describe('runConcurrent', () => {
  it('runs all tasks and returns fulfilled results', async () => {
    const tasks = [1, 2, 3].map(n => () => Promise.resolve(n));
    const results = await runConcurrent(tasks, 2);
    expect(results).toHaveLength(3);
    results.forEach((r, i) => {
      expect(r).toEqual({ status: 'fulfilled', value: i + 1 });
    });
  });

  it('captures rejected tasks without throwing', async () => {
    const tasks = [
      () => Promise.resolve('good'),
      () => Promise.reject(new Error('bad')),
    ];
    const results = await runConcurrent(tasks, 2);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'good' });
    expect(results[1].status).toBe('rejected');
  });

  it('respects concurrency limit', async () => {
    let running = 0;
    let maxRunning = 0;
    const tasks = Array.from({ length: 6 }, () => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await sleep(20);
      running--;
    });
    await runConcurrent(tasks, 2);
    expect(maxRunning).toBeLessThanOrEqual(2);
  });
});

// ─── logError ────────────────────────────────────────────────────────────────

describe('logError', () => {
  it('writes a line to the error log file', () => {
    const appendSpy = jest.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
    logError('SKU123', 'Amazon', 'timeout');
    expect(appendSpy).toHaveBeenCalledTimes(1);
    const written = appendSpy.mock.calls[0][1] as string;
    expect(written).toContain('SKU123');
    expect(written).toContain('Amazon');
    expect(written).toContain('timeout');
    appendSpy.mockRestore();
  });
});