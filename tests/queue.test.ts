import { describe, expect, it, vi } from 'vitest';
import { CommandQueue } from '../src/runtime/queue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('CommandQueue', () => {
  it('runs one transport request at a time and preserves enqueue order despite delays', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const log: string[] = [];
    const queue = new CommandQueue();
    const a = queue.enqueue(async () => {
      log.push('start a');
      const result = await first.promise;
      log.push('finish a');
      return result;
    });
    const b = queue.enqueue(async () => {
      log.push('start b');
      const result = await second.promise;
      log.push('finish b');
      return result;
    });
    const c = queue.enqueue(async () => {
      log.push('start c');
      return 'c';
    });
    expect(log).toEqual(['start a']);
    // Even if a later operation is already ready, it must not pass the first one.
    second.resolve('b');
    await Promise.resolve();
    expect(log).toEqual(['start a']);
    first.resolve('a');
    expect(await Promise.all([a, b, c])).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['start a', 'finish a', 'start b', 'finish b', 'start c']);
  });

  it('keeps a failed request at the head and blocks later work until retry', async () => {
    const failure = new Error('reply was interrupted');
    const transport = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce('committed');
    const states: { pending: number; error: unknown }[] = [];
    const queue = new CommandQueue((pending, error) => states.push({ pending, error }));
    let laterRan = false;
    const head = queue.enqueue(transport);
    const later = queue.enqueue(async () => {
      laterRan = true;
      return 2;
    });
    await vi.waitFor(() => expect(queue.blocked).toBe(true));
    expect(laterRan).toBe(false);
    expect(states.at(-1)).toEqual({ pending: 2, error: failure });
    queue.retry();
    expect(await head).toBe('committed');
    expect(await later).toBe(2);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(queue.blocked).toBe(false);
    expect(states.at(-1)).toEqual({ pending: 0, error: null });
  });

  it('retries the identical command ID after a transport failure with an uncertain commit', async () => {
    const queue = new CommandQueue();
    const envelope = { commandId: 'stable-id', sessionId: 'session', command: { type: 'undo' } };
    const seen: string[] = [];
    const replies = new Map<string, { stateId: string }>();
    let commits = 0;
    const dispatch = async (command: typeof envelope) => {
      seen.push(command.commandId);
      const previous = replies.get(command.commandId);
      if (previous) return previous;
      const reply = { stateId: `state-${++commits}` };
      replies.set(command.commandId, reply);
      throw new Error('connection dropped after commit');
    };
    const pending = queue.enqueue(() => dispatch(envelope));
    await vi.waitFor(() => expect(queue.blocked).toBe(true));
    queue.retry();
    expect(await pending).toEqual({ stateId: 'state-1' });
    expect(seen).toEqual(['stable-id', 'stable-id']);
    expect(commits).toBe(1);
  });

  it('drain waits for all prior work and does not wait for later work', async () => {
    const first = deferred<number>();
    const later = deferred<number>();
    const queue = new CommandQueue();
    const a = queue.enqueue(() => first.promise);
    let drained = false;
    const barrier = queue.drain().then(() => {
      drained = true;
    });
    let laterFinished = false;
    const b = queue.enqueue(async () => {
      const result = await later.promise;
      laterFinished = true;
      return result;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    first.resolve(1);
    await barrier;
    expect(drained).toBe(true);
    expect(laterFinished).toBe(false);
    later.resolve(2);
    expect(await Promise.all([a, b])).toEqual([1, 2]);
  });

  it('a drain barrier remains pending behind a failed head until that head is retried', async () => {
    const queue = new CommandQueue();
    let attempts = 0;
    const head = queue.enqueue(async () => {
      if (++attempts === 1) throw new Error('temporary');
      return 1;
    });
    let drained = false;
    const barrier = queue.drain().then(() => {
      drained = true;
    });
    await vi.waitFor(() => expect(queue.blocked).toBe(true));
    expect(drained).toBe(false);
    queue.retry();
    await Promise.all([head, barrier]);
    expect(drained).toBe(true);
  });
});
