// WASM Loader - Fetches WASM resources in main thread and transfers to workers
// This allows Service Worker to intercept and cache WASM requests for offline support

export interface WasmTransferMessage {
    type: 'WASM_TRANSFER';
    wasmBytes: ArrayBuffer;
    wasmUrl?: string;
}

export interface WasmInitMessage {
    type: 'INIT_WITH_WASM';
    wasmBytes: ArrayBuffer;
}

/**
 * Fetches WASM resource in the main thread
 * This allows Service Worker to intercept the request
 */
export async function fetchWasmResource(wasmUrl: string | URL): Promise<ArrayBuffer> {
    const url = typeof wasmUrl === 'string' ? wasmUrl : wasmUrl.href;
    
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch WASM: ${response.status} ${response.statusText}`);
        }
        
        const wasmBytes = await response.arrayBuffer();
        return wasmBytes;
    } catch (error) {
        console.error('Failed to fetch WASM resource:', error);
        throw error;
    }
}

/**
 * Transfers WASM bytes to a worker using Transferable Objects
 * This transfers ownership of the ArrayBuffer to the worker
 */
export function transferWasmToWorker(
    worker: Worker, 
    wasmBytes: ArrayBuffer,
    messageType: string = 'WASM_TRANSFER',
    additionalData?: Record<string, any>
): void {
    // Create a new ArrayBuffer for transfer (original might not be transferable)
    const transferableBuffer = wasmBytes.slice(0);
    
    const message = {
        type: messageType,
        wasmBytes: transferableBuffer,
        ...additionalData
    };
    
    // Transfer ownership of the ArrayBuffer to the worker
    worker.postMessage(message, [transferableBuffer]);
}

