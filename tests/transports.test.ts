import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { createTransport as createDesktopTransport } from '../src/runtime/transports/desktop';
import { createTransport } from '../src/runtime/transports/web';
import type { Envelope } from '../src/generated/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

class WorkerDouble {
  static instances: WorkerDouble[] = [];
  messages: { id: number; method: string; args: unknown[] }[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { message: string; preventDefault(): void }) => void;
  onmessageerror?: () => void;
  terminated = false;
  constructor() {
    WorkerDouble.instances.push(this);
  }
  postMessage(message: { id: number; method: string; args: unknown[] }) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(index: number, result?: unknown, error?: string) {
    this.onmessage?.({ data: { id: this.messages[index].id, result, error } });
  }
}

beforeEach(() => {
  WorkerDouble.instances = [];
  vi.stubGlobal('Worker', WorkerDouble);
  vi.mocked(invoke).mockReset();
});
afterEach(() => vi.unstubAllGlobals());

async function initialized() {
  const transport = createTransport();
  const worker = WorkerDouble.instances[0];
  worker.reply(0);
  await transport.ready();
  return { transport, worker };
}

describe('worker transport', () => {
  it('waits for startup before sending a receipt and retries failed receipts independently', async () => {
    const transport = createTransport();
    const worker = WorkerDouble.instances[0];
    const first = transport.acknowledge('session', 'command');
    expect(worker.messages.map((message) => message.method)).toEqual(['ready']);
    worker.reply(0);
    await transport.ready();
    expect(worker.messages[1]).toMatchObject({
      method: 'acknowledge',
      args: ['session', 'command'],
    });
    const rejected = expect(first).rejects.toThrow('Receipt lost');
    worker.reply(1, undefined, 'Receipt lost');
    await rejected;

    const repeated = transport.acknowledge('session', 'command');
    await Promise.resolve();
    worker.reply(2);
    await expect(repeated).resolves.toBeUndefined();
    expect(worker.messages.slice(1).map(({ method, args }) => ({ method, args }))).toEqual([
      { method: 'acknowledge', args: ['session', 'command'] },
      { method: 'acknowledge', args: ['session', 'command'] },
    ]);
    transport.dispose();
    await expect(transport.acknowledge('session', 'command')).rejects.toThrow('disposed');
  });

  it('correlates out-of-order responses without transferring caller-owned image buffers', async () => {
    const { transport, worker } = await initialized();
    const bytes = new Uint8Array([1, 2, 3]);
    const first = transport.probeImage(bytes);
    const second = transport.dispatch({ commandId: 'two' } as Envelope);
    await Promise.resolve();
    expect(worker.messages.map((m) => m.method)).toEqual(['ready', 'probeImage', 'dispatch']);
    worker.reply(2, { commandId: 'two' });
    worker.reply(1, { width: 3 });
    await expect(second).resolves.toEqual({ commandId: 'two' });
    await expect(first).resolves.toEqual({ width: 3 });
    expect([...bytes]).toEqual([1, 2, 3]);
    transport.dispose();
  });

  it('rejects every pending request after a worker crash and rejects later calls', async () => {
    const { transport, worker } = await initialized();
    const first = transport.exportProject('one', 'bf');
    const second = transport.exportProject('two', 'bf');
    const checked = Promise.all([
      expect(first).rejects.toThrow('crashed'),
      expect(second).rejects.toThrow('crashed'),
    ]);
    await Promise.resolve();
    worker.onerror?.({ message: 'Core crashed', preventDefault() {} });
    await checked;
    await expect(transport.probeImage(new Uint8Array())).rejects.toThrow('crashed');
    transport.dispose();
  });

  it('keeps a format failure local to its request and terminates cleanly', async () => {
    const { transport, worker } = await initialized();
    const imported = transport.importProject(new Uint8Array(), 'bf', 'one');
    const checked = expect(imported).rejects.toThrow('Invalid archive');
    await Promise.resolve();
    worker.reply(1, undefined, 'Invalid archive');
    await checked;
    const exported = transport.exportProject('one', 'bf');
    await Promise.resolve();
    worker.reply(2, new Uint8Array([4, 5]));
    await expect(exported).resolves.toEqual(new Uint8Array([4, 5]));
    transport.dispose();
    expect(worker.terminated).toBe(true);
    await expect(transport.dispatch({} as Envelope)).rejects.toThrow('disposed');
  });
});

describe('desktop transport', () => {
  it('sends receipt identifiers to the host and rejects calls after disposal', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const transport = createDesktopTransport();
    await expect(transport.acknowledge('session', 'command')).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith(
      'core_acknowledge',
      { sessionId: 'session', commandId: 'command' },
      undefined,
    );
    transport.dispose();
    await expect(transport.acknowledge('session', 'command')).rejects.toThrow('disposed');
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('allows a failed receipt to be retried without dispatching a command', async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce({ message: 'Receipt lost' })
      .mockResolvedValueOnce(undefined);
    const transport = createDesktopTransport();
    await expect(transport.acknowledge('session', 'command')).rejects.toThrow('Receipt lost');
    await expect(transport.acknowledge('session', 'command')).resolves.toBeUndefined();
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
      'core_acknowledge',
      'core_acknowledge',
    ]);
    transport.dispose();
  });
});
