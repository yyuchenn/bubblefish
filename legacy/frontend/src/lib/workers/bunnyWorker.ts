// Bunny Worker - Handles OCR and translation tasks in background
import type { BunnyWorkerMessage, BunnyWorkerResponse, BunnyTask } from '../types/bunny';

interface TaskQueue {
	queue: BunnyTask[];
	processing: Map<string, BunnyTask>;
	completed: Map<string, BunnyTask>;
}

class BunnyWorker {
	private taskQueue: TaskQueue = {
		queue: [],
		processing: new Map(),
		completed: new Map()
	};
	
	private isProcessing = false;
	private maxConcurrent = 3;
	private abortControllers = new Map<string, AbortController>();

	constructor() {
		// Set up message handler
		self.addEventListener('message', (event: MessageEvent<BunnyWorkerMessage | { type: 'task_completed_notification'; taskId: string }>) => {
			this.handleMessage(event.data);
		});
		
		// Periodically clean up completed tasks
		setInterval(() => this.cleanupCompletedTasks(), 5000);
	}

	private handleMessage(message: BunnyWorkerMessage | { type: 'task_completed_notification'; taskId: string }) {
		switch (message.type) {
			case 'ocr_request':
				this.queueOCRTask(message as Extract<BunnyWorkerMessage, { type: 'ocr_request' }>);
				break;
			case 'translation_request':
				this.queueTranslationTask(message as Extract<BunnyWorkerMessage, { type: 'translation_request' }>);
				break;
			case 'cancel_task':
				this.cancelTask((message as Extract<BunnyWorkerMessage, { type: 'cancel_task' }>).taskId);
				break;
			case 'get_queue_status':
				this.sendQueueStatus();
				break;
			case 'clear_queue':
				this.clearQueue();
				break;
			case 'task_completed_notification':
				this.handleTaskCompleted(message.taskId);
				break;
		}
		
		// Start processing if not already running
		if (!this.isProcessing) {
			this.processQueue();
		}
	}

	private queueOCRTask(message: Extract<BunnyWorkerMessage, { type: 'ocr_request' }>) {
		const task: BunnyTask = {
			id: message.taskId,
			markerId: message.markerId,
			imageId: message.imageId,
			type: 'ocr',
			status: 'queued',
			model: message.model,
			createdAt: Date.now()
		};
		
		this.taskQueue.queue.push(task);
		this.postMessage({ type: 'task_started', taskId: task.id, markerId: task.markerId });
	}

	private queueTranslationTask(message: Extract<BunnyWorkerMessage, { type: 'translation_request' }>) {
		const task: BunnyTask = {
			id: message.taskId,
			markerId: message.markerId,
			imageId: 0, // Will be set from marker data
			type: 'translation',
			status: 'queued',
			service: message.service,
			createdAt: Date.now()
		};
		
		this.taskQueue.queue.push(task);
		this.postMessage({ type: 'task_started', taskId: task.id, markerId: task.markerId });
	}

	private async processQueue() {
		if (this.isProcessing) return;
		this.isProcessing = true;

		while (this.taskQueue.queue.length > 0 || this.taskQueue.processing.size > 0) {
			// Process up to maxConcurrent tasks
			while (this.taskQueue.processing.size < this.maxConcurrent && this.taskQueue.queue.length > 0) {
				const task = this.taskQueue.queue.shift();
				if (task) {
					// Just mark as processing and notify frontend
					// The actual processing happens in the backend
					task.status = 'processing';
					task.startedAt = Date.now();
					this.taskQueue.processing.set(task.id, task);
					this.postMessage({ type: 'task_started', taskId: task.id, markerId: task.markerId });
				}
			}

			// Wait a bit before checking again
			await new Promise(resolve => setTimeout(resolve, 100));
		}

		this.isProcessing = false;
	}



	private cancelTask(taskId: string) {
		// Cancel if in queue
		const queueIndex = this.taskQueue.queue.findIndex(t => t.id === taskId);
		if (queueIndex >= 0) {
			const task = this.taskQueue.queue.splice(queueIndex, 1)[0];
			task.status = 'cancelled';
			this.postMessage({ type: 'task_cancelled', taskId, markerId: task.markerId });
			return;
		}

		// Cancel if processing
		const abortController = this.abortControllers.get(taskId);
		if (abortController) {
			abortController.abort();
			const task = this.taskQueue.processing.get(taskId);
			if (task) {
				task.status = 'cancelled';
				this.postMessage({ type: 'task_cancelled', taskId, markerId: task.markerId });
			}
		}
	}

	private clearQueue() {
		// Cancel all queued tasks
		for (const task of this.taskQueue.queue) {
			task.status = 'cancelled';
			this.postMessage({ type: 'task_cancelled', taskId: task.id, markerId: task.markerId });
		}
		this.taskQueue.queue = [];

		// Cancel all processing tasks
		for (const [, controller] of this.abortControllers) {
			controller.abort();
		}
	}

	private sendQueueStatus() {
		const status = {
			totalTasks: this.taskQueue.queue.length + this.taskQueue.processing.size + this.taskQueue.completed.size,
			queuedTasks: this.taskQueue.queue.length,
			processingTasks: this.taskQueue.processing.size,
			completedTasks: Array.from(this.taskQueue.completed.values()).filter(t => t.status === 'completed').length,
			failedTasks: Array.from(this.taskQueue.completed.values()).filter(t => t.status === 'failed').length
		};
		
		this.postMessage({ type: 'queue_status', status });
	}

	private handleTaskCompleted(taskId: string) {
		// Move task from processing to completed
		const task = this.taskQueue.processing.get(taskId);
		if (task) {
			task.status = 'completed';
			task.completedAt = Date.now();
			this.taskQueue.processing.delete(taskId);
			this.taskQueue.completed.set(taskId, task);
		}
	}
	
	private cleanupCompletedTasks() {
		// Remove old completed tasks (older than 1 minute)
		const now = Date.now();
		const oneMinuteAgo = now - 60000;
		
		for (const [taskId, task] of this.taskQueue.completed.entries()) {
			if (task.completedAt && task.completedAt < oneMinuteAgo) {
				this.taskQueue.completed.delete(taskId);
			}
		}
	}
	
	private postMessage(response: BunnyWorkerResponse) {
		self.postMessage(response);
	}
}

// Initialize worker
new BunnyWorker();