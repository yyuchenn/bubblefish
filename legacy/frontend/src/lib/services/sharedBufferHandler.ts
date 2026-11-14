import { pluginBridge } from './pluginBridge';

/**
 * SharedArrayBuffer ring buffer handler
 * Processes synchronous service calls from plugins using a streaming ring buffer
 */
export class SharedBufferHandler {
    private buffer: SharedArrayBuffer;
    private headerArray: Int32Array;
    private dataArray: Uint8Array;
    private running: boolean = false;
    private dataStartOffset: number;
    private ringBufferSize: number;

    // Status constants
    private readonly STATUS_IDLE = 0;
    private readonly STATUS_REQUEST = 1;
    private readonly STATUS_RESPONSE = 2;
    private readonly STATUS_ERROR = 3;

    // Header offsets (i32 indices)
    private readonly OFFSET_STATUS = 0;
    private readonly OFFSET_REQUEST_ID = 1;
    private readonly OFFSET_WRITER_POS = 2;
    private readonly OFFSET_READER_POS = 3;
    private readonly OFFSET_TOTAL_SIZE = 4;
    private readonly OFFSET_CHUNK_SIZE = 5;
    private readonly OFFSET_ERROR_CODE = 6;
    // @ts-ignore - Reserved for future use
    private readonly OFFSET_RESERVED = 7;

    // Constants
    private readonly HEADER_SIZE = 32; // 8 x 4 bytes
    private readonly DEFAULT_CHUNK_SIZE = 64 * 1024; // 64KB chunks

    constructor(bufferSize: number = 10 * 1024 * 1024) { // 10MB default
        // Create SharedArrayBuffer
        this.buffer = new SharedArrayBuffer(bufferSize);
        
        // Header uses first 32 bytes
        this.headerArray = new Int32Array(this.buffer, 0, this.HEADER_SIZE / 4);
        
        // Data uses entire buffer (for byte-level access)
        this.dataArray = new Uint8Array(this.buffer);
        
        // Calculate ring buffer parameters
        this.dataStartOffset = this.HEADER_SIZE;
        this.ringBufferSize = bufferSize - this.HEADER_SIZE;
        
        // Initialize status to idle
        Atomics.store(this.headerArray, this.OFFSET_STATUS, this.STATUS_IDLE);
    }

    /**
     * Start monitoring for requests
     */
    start() {
        if (this.running) return;
        
        this.running = true;
        this.monitorRequests();
    }

    /**
     * Stop monitoring
     */
    stop() {
        this.running = false;
    }

    /**
     * Monitor for incoming requests
     */
    private monitorRequests() {
        const checkForRequests = async () => {
            if (!this.running) return;

            const status = Atomics.load(this.headerArray, this.OFFSET_STATUS);
            
            if (status === this.STATUS_REQUEST) {
                // Process the request
                await this.handleRequest();
            }

            // Continue monitoring
            if (this.running) {
                requestAnimationFrame(() => checkForRequests());
            }
        };

        checkForRequests();
    }

    /**
     * Handle incoming request
     */
    private async handleRequest() {
        try {
            // Read request using ring buffer
            const requestData = await this.readFromRingBuffer();
            
            if (!requestData) {
                throw new Error('Failed to read request data');
            }

            // Parse request
            const requestText = new TextDecoder().decode(requestData);
            const request = JSON.parse(requestText);
            
            const requestId = Atomics.load(this.headerArray, this.OFFSET_REQUEST_ID);

            // Call service
            const result = await this.callService(request.service, request.method, request.params);
            
            // Write response using ring buffer
            await this.writeToRingBuffer(result, requestId);
            
        } catch (error) {
            console.error('[SharedBufferHandler] Error handling request:', error);
            this.writeError(error instanceof Error ? error.message : 'Unknown error');
        }
    }

    /**
     * Read data from ring buffer
     */
    private async readFromRingBuffer(): Promise<Uint8Array | null> {
        const totalSize = Atomics.load(this.headerArray, this.OFFSET_TOTAL_SIZE);
        
        if (totalSize <= 0) {
            return null;
        }

        const data = new Uint8Array(totalSize);
        let read = 0;

        while (read < totalSize) {
            const writerPos = Atomics.load(this.headerArray, this.OFFSET_WRITER_POS);
            const readerPos = Atomics.load(this.headerArray, this.OFFSET_READER_POS);
            
            // Calculate available data
            const available = writerPos >= readerPos
                ? writerPos - readerPos
                : this.ringBufferSize - readerPos + writerPos;
            
            if (available === 0) {
                // Wait for data
                await new Promise(resolve => setTimeout(resolve, 1));
                continue;
            }
            
            // Calculate how much to read
            const remaining = totalSize - read;
            const readSize = Math.min(remaining, available);
            
            // Read from ring buffer
            const readEnd = readerPos + readSize;
            if (readEnd <= this.ringBufferSize) {
                // Simple case: continuous read
                for (let i = 0; i < readSize; i++) {
                    data[read + i] = this.dataArray[this.dataStartOffset + readerPos + i];
                }
            } else {
                // Wrap around case
                const firstPart = this.ringBufferSize - readerPos;
                for (let i = 0; i < firstPart; i++) {
                    data[read + i] = this.dataArray[this.dataStartOffset + readerPos + i];
                }
                const secondPart = readSize - firstPart;
                for (let i = 0; i < secondPart; i++) {
                    data[read + firstPart + i] = this.dataArray[this.dataStartOffset + i];
                }
            }
            
            read += readSize;
            
            // Update reader position
            const newReaderPos = readEnd % this.ringBufferSize;
            Atomics.store(this.headerArray, this.OFFSET_READER_POS, newReaderPos);
            
            // Notify writer that space is available
            Atomics.notify(this.headerArray, this.OFFSET_READER_POS, 1);
        }

        return data;
    }

    /**
     * Write data to ring buffer
     */
    private async writeToRingBuffer(result: any, requestId: number) {
        // Serialize response
        const responseText = JSON.stringify(result);
        const responseBytes = new TextEncoder().encode(responseText);
        
        // Reset positions for response
        Atomics.store(this.headerArray, this.OFFSET_WRITER_POS, 0);
        Atomics.store(this.headerArray, this.OFFSET_READER_POS, 0);
        
        // Set metadata
        Atomics.store(this.headerArray, this.OFFSET_REQUEST_ID, requestId);
        Atomics.store(this.headerArray, this.OFFSET_TOTAL_SIZE, responseBytes.length);
        Atomics.store(this.headerArray, this.OFFSET_CHUNK_SIZE, this.DEFAULT_CHUNK_SIZE);
        
        const totalSize = responseBytes.length;
        let written = 0;

        while (written < totalSize) {
            const writerPos = Atomics.load(this.headerArray, this.OFFSET_WRITER_POS);
            const readerPos = Atomics.load(this.headerArray, this.OFFSET_READER_POS);
            
            // Calculate available space
            const availableSpace = writerPos >= readerPos
                ? this.ringBufferSize - writerPos + readerPos
                : readerPos - writerPos;
            
            if (availableSpace <= 1) {
                // Buffer full, wait for reader
                await new Promise(resolve => setTimeout(resolve, 1));
                continue;
            }
            
            // Calculate how much to write
            const remaining = totalSize - written;
            const writeSize = Math.min(remaining, availableSpace - 1, this.DEFAULT_CHUNK_SIZE);
            
            // Write to ring buffer
            const writeEnd = writerPos + writeSize;
            if (writeEnd <= this.ringBufferSize) {
                // Simple case: continuous write
                for (let i = 0; i < writeSize; i++) {
                    this.dataArray[this.dataStartOffset + writerPos + i] = responseBytes[written + i];
                }
            } else {
                // Wrap around case
                const firstPart = this.ringBufferSize - writerPos;
                for (let i = 0; i < firstPart; i++) {
                    this.dataArray[this.dataStartOffset + writerPos + i] = responseBytes[written + i];
                }
                const secondPart = writeSize - firstPart;
                for (let i = 0; i < secondPart; i++) {
                    this.dataArray[this.dataStartOffset + i] = responseBytes[written + firstPart + i];
                }
            }
            
            written += writeSize;
            
            // Update writer position
            const newWriterPos = writeEnd % this.ringBufferSize;
            Atomics.store(this.headerArray, this.OFFSET_WRITER_POS, newWriterPos);
            
            // Notify reader that data is available
            Atomics.notify(this.headerArray, this.OFFSET_WRITER_POS, 1);
        }

        // Set response status
        Atomics.store(this.headerArray, this.OFFSET_STATUS, this.STATUS_RESPONSE);
        Atomics.notify(this.headerArray, this.OFFSET_STATUS, 1);
    }

    /**
     * Call service through plugin bridge
     */
    private async callService(service: string, method: string, params: any): Promise<any> {
        const request = {
            pluginId: 'shared-buffer',
            service,
            method,
            params
        };
        
        return await pluginBridge.handleServiceCall(request);
    }

    /**
     * Write error response
     */
    private writeError(message: string) {
        // Write error message as response
        const errorResponse = { error: message };
        const errorBytes = new TextEncoder().encode(JSON.stringify(errorResponse));
        
        // Reset positions
        Atomics.store(this.headerArray, this.OFFSET_WRITER_POS, 0);
        Atomics.store(this.headerArray, this.OFFSET_READER_POS, 0);
        
        // Write error data (limited to ring buffer size)
        const writeSize = Math.min(errorBytes.length, this.ringBufferSize);
        for (let i = 0; i < writeSize; i++) {
            this.dataArray[this.dataStartOffset + i] = errorBytes[i];
        }
        
        // Set error metadata
        Atomics.store(this.headerArray, this.OFFSET_TOTAL_SIZE, writeSize);
        Atomics.store(this.headerArray, this.OFFSET_WRITER_POS, writeSize);
        Atomics.store(this.headerArray, this.OFFSET_ERROR_CODE, 1);
        Atomics.store(this.headerArray, this.OFFSET_STATUS, this.STATUS_ERROR);
        
        // Notify waiting thread
        Atomics.notify(this.headerArray, this.OFFSET_STATUS, 1);
    }

    /**
     * Get the SharedArrayBuffer
     */
    getBuffer(): SharedArrayBuffer {
        return this.buffer;
    }
}

// Create global instance
export const sharedBufferHandler = new SharedBufferHandler();