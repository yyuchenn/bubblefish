import type { JsonValue, PluginMessage, PluginRpcError } from '../../generated/plugins';
import { newId } from './types';

export interface Packet {
  message: PluginMessage;
  binary?: ArrayBuffer;
}
export interface RpcResult {
  result: JsonValue;
  binary?: ArrayBuffer;
}
export interface ControlledRequest {
  id: string;
  result: Promise<RpcResult>;
  /** Request cooperative cancellation while retaining the real response boundary. */
  cancel(): void;
}
export type RequestHandler = (
  method: string,
  params: JsonValue,
  binary: ArrayBuffer | undefined,
  id: string,
) => Promise<RpcResult>;
export class RpcError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}
export class RpcPeer {
  private pending = new Map<
    string,
    { resolve(value: RpcResult): void; reject(error: Error): void; cleanup(): void }
  >();
  private closed = false;
  constructor(
    private send: (packet: Packet) => void,
    private handler: RequestHandler,
    private event: (name: string, data: JsonValue, binary?: ArrayBuffer) => void = () => {},
  ) {}
  requestControlled(
    method: string,
    params: JsonValue = null,
    options: { binary?: ArrayBuffer } = {},
  ): ControlledRequest {
    const id = newId();
    let cancelled = false;
    const result = new Promise<RpcResult>((resolve, reject) => {
      if (this.closed) {
        reject(new RpcError('closed', 'Plugin connection is closed'));
        return;
      }
      const cancelledError = () => new DOMException('Cancelled', 'AbortError');
      this.pending.set(id, {
        resolve: (value) => (cancelled ? reject(cancelledError()) : resolve(value)),
        reject: (error) => reject(cancelled ? cancelledError() : error),
        cleanup() {},
      });
      try {
        this.send({
          message: {
            kind: 'request',
            apiVersion: 1,
            id,
            method,
            params,
            ...(options.binary ? { binary: { byteLength: options.binary.byteLength } } : {}),
          },
          binary: options.binary,
        });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return {
      id,
      result,
      cancel: () => {
        if (cancelled || !this.pending.has(id)) return;
        cancelled = true;
        // Even an uncooperative plugin must settle or disconnect before its queue advances.
        try {
          this.emit('$cancel', { requestId: id });
        } catch {
          /* Await response or explicit shutdown. */
        }
      },
    };
  }
  request(
    method: string,
    params: JsonValue = null,
    options: { binary?: ArrayBuffer; signal?: AbortSignal; timeout?: number } = {},
  ): Promise<RpcResult> {
    if (this.closed) return Promise.reject(new RpcError('closed', 'Plugin connection is closed'));
    if (options.signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    const id = newId();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        try {
          this.emit('$cancel', { requestId: id });
        } catch {
          /* Closing a broken connection still settles cancellation. */
        } finally {
          finish(new DOMException('Cancelled', 'AbortError'));
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      const finish = (error: Error) => {
        this.pending.delete(id);
        cleanup();
        reject(error);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      if (options.timeout !== 0)
        timer = setTimeout(
          () => finish(new RpcError('timeout', `Plugin request timed out: ${method}`)),
          options.timeout ?? 30000,
        );
      options.signal?.addEventListener('abort', abort, { once: true });
      try {
        this.send({
          message: {
            kind: 'request',
            apiVersion: 1,
            id,
            method,
            params,
            ...(options.binary ? { binary: { byteLength: options.binary.byteLength } } : {}),
          },
          binary: options.binary,
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  emit(event: string, data: JsonValue, binary?: ArrayBuffer) {
    if (!this.closed)
      this.send({
        message: {
          kind: 'event',
          apiVersion: 1,
          event,
          data,
          ...(binary ? { binary: { byteLength: binary.byteLength } } : {}),
        },
        binary,
      });
  }
  async receive(packet: Packet) {
    if (this.closed) return;
    const message = packet?.message;
    if (
      !message ||
      message.apiVersion !== 1 ||
      !['request', 'response', 'event'].includes(message.kind) ||
      (message.kind === 'request' &&
        (typeof message.id !== 'string' || typeof message.method !== 'string')) ||
      (message.kind === 'response' && typeof message.id !== 'string') ||
      (message.kind === 'event' && typeof message.event !== 'string')
    ) {
      const error = new RpcError('protocol', 'Invalid plugin protocol message');
      this.close(error);
      throw error;
    }
    if ((message.binary?.byteLength ?? 0) !== (packet.binary?.byteLength ?? 0)) {
      const error = new RpcError('protocol', 'Plugin binary length mismatch');
      this.close(error);
      throw error;
    }
    if (message.kind === 'response') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.cleanup();
      if (message.error) pending.reject(new RpcError(message.error.code, message.error.message));
      else pending.resolve({ result: message.result ?? null, binary: packet.binary });
    } else if (message.kind === 'event') {
      this.event(message.event, message.data, packet.binary);
    } else {
      let response: { result?: JsonValue; error?: PluginRpcError; binary?: { byteLength: number } };
      let binary: ArrayBuffer | undefined;
      try {
        const value = await this.handler(message.method, message.params, packet.binary, message.id);
        binary = value.binary;
        response = {
          result: value.result,
          ...(binary ? { binary: { byteLength: binary.byteLength } } : {}),
        };
      } catch (error) {
        response = {
          error: {
            code: error instanceof RpcError ? error.code : 'plugin_error',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
      if (!this.closed)
        this.send({
          message: { kind: 'response', apiVersion: 1, id: message.id, ...response },
          binary,
        });
    }
  }
  close(error = new RpcError('closed', 'Plugin connection closed')) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export function encodeFrame(packet: Packet): ArrayBuffer {
  const json = encoder.encode(JSON.stringify(packet.message));
  const binary = packet.binary ? new Uint8Array(packet.binary) : new Uint8Array();
  if (json.length > 8 * 1024 * 1024 || binary.length > 512 * 1024 * 1024)
    throw new RpcError('size', 'Plugin frame exceeds size limit');
  const frame = new Uint8Array(8 + json.length + binary.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, json.length, true);
  view.setUint32(4, binary.length, true);
  frame.set(json, 8);
  frame.set(binary, 8 + json.length);
  return frame.buffer;
}
export function decodeFrame(buffer: ArrayBuffer): Packet {
  if (buffer.byteLength < 8) throw new RpcError('protocol', 'Truncated plugin frame');
  const view = new DataView(buffer);
  const jsonLength = view.getUint32(0, true);
  const binaryLength = view.getUint32(4, true);
  if (
    jsonLength > 8 * 1024 * 1024 ||
    binaryLength > 512 * 1024 * 1024 ||
    buffer.byteLength !== 8 + jsonLength + binaryLength
  )
    throw new RpcError('protocol', 'Invalid plugin frame size');
  const message = JSON.parse(
    decoder.decode(new Uint8Array(buffer, 8, jsonLength)),
  ) as PluginMessage;
  return { message, ...(binaryLength ? { binary: buffer.slice(8 + jsonLength) } : {}) };
}
