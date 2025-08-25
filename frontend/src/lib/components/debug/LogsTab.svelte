<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { eventService, type LogEvent } from '$lib/services/eventService';
	import { SvelteSet } from 'svelte/reactivity';

	let logs: LogEvent[] = $state([]);
	let unsubscribeLog: (() => void) | null = null;
	const maxLogs = 100; // 最大日志条数，避免内存溢出
	let logContainer = $state<HTMLElement>();
	const expandedLogs = new SvelteSet<string>();

	// 过滤器状态
	let showDebug = $state(true);
	let showInfo = $state(true);
	let showWarn = $state(true);
	let showError = $state(true);
	let searchFilter = $state('');

	// 计算过滤后的日志 - 使用$derived
	let filteredLogs = $derived(
		logs.filter((log) => {
			// 级别过滤
			const levelMatch =
				(log.level === 'Debug' && showDebug) ||
				(log.level === 'Info' && showInfo) ||
				(log.level === 'Warn' && showWarn) ||
				(log.level === 'Error' && showError);

			// 文本过滤
			const textMatch =
				searchFilter === '' ||
				log.message.toLowerCase().includes(searchFilter.toLowerCase()) ||
				(log.data && JSON.stringify(log.data).toLowerCase().includes(searchFilter.toLowerCase()));

			return levelMatch && textMatch;
		})
	);

	onMount(() => {
		// 订阅日志事件
		unsubscribeLog = eventService.onLog((logEvent: LogEvent) => {
			// 确保每个日志都有唯一的标识符
			const logWithId = {
				...logEvent,
				id: `${logEvent.timestamp}-${Math.random().toString(36).substring(2, 11)}`
			};

			logs.push(logWithId);

			// 限制日志数量
			if (logs.length > maxLogs) {
				logs = logs.slice(-maxLogs);
			}

			// 自动滚动到底部
			if (logContainer) {
				setTimeout(() => {
					if (logContainer) {
						logContainer.scrollTop = logContainer.scrollHeight;
					}
				}, 0);
			}
		});
	});

	onDestroy(() => {
		if (unsubscribeLog) {
			unsubscribeLog();
		}
	});

	function clearLogs() {
		logs = [];
	}

	function formatTime(timestamp: number): string {
		return new Date(timestamp).toLocaleTimeString();
	}

	function getLevelBadgeColor(level: string): string {
		switch (level) {
			case 'Debug':
				return 'bg-theme-surface-variant text-theme-on-surface-variant';
			case 'Info':
				return 'bg-theme-primary-container text-theme-on-primary-container';
			case 'Warn':
				return 'bg-yellow-100 text-yellow-800';
			case 'Error':
				return 'bg-theme-error-container text-theme-on-error-container';
			default:
				return 'bg-theme-surface-variant text-theme-on-surface-variant';
		}
	}

	// 格式化显示数据
	function formatData(data: unknown): string {
		if (!data) return '';
		try {
			return JSON.stringify(data, null, 2);
		} catch {
			return String(data);
		}
	}

	// 切换日志展开状态
	function toggleLogExpanded(logId: string) {
		if (expandedLogs.has(logId)) {
			expandedLogs.delete(logId);
		} else {
			expandedLogs.add(logId);
		}
	}

	// 复制文本到剪贴板
	async function copyToClipboard(text: string) {
		try {
			await navigator.clipboard.writeText(text);
		} catch (err) {
			console.error('Failed to copy:', err);
		}
	}
	
	// 类型安全的属性检查
	function hasStackTrace(data: unknown): data is { stack_trace: string } {
		return data !== null && typeof data === 'object' && 'stack_trace' in data;
	}
	
	function hasPanicMessage(data: unknown): data is { panic_message: string } {
		return data !== null && typeof data === 'object' && 'panic_message' in data;
	}
</script>

<div class="flex h-full flex-col">
	<!-- 过滤器 -->
	<div class="border-theme-outline bg-theme-surface-variant border-b p-3">
		<div class="mb-2 flex items-center gap-3">
			<label class="flex items-center gap-1">
				<input type="checkbox" bind:checked={showDebug} class="text-theme-primary h-3 w-3" />
				<span class="text-theme-on-surface text-xs">Debug</span>
			</label>
			<label class="flex items-center gap-1">
				<input type="checkbox" bind:checked={showInfo} class="text-theme-primary h-3 w-3" />
				<span class="text-theme-on-surface text-xs">Info</span>
			</label>
			<label class="flex items-center gap-1">
				<input type="checkbox" bind:checked={showWarn} class="text-theme-primary h-3 w-3" />
				<span class="text-theme-on-surface text-xs">Warn</span>
			</label>
			<label class="flex items-center gap-1">
				<input type="checkbox" bind:checked={showError} class="text-theme-primary h-3 w-3" />
				<span class="text-theme-on-surface text-xs">Error</span>
			</label>
		</div>
		<div class="flex items-center gap-2">
			<input
				type="text"
				placeholder="搜索日志..."
				bind:value={searchFilter}
				class="border-theme-outline focus:border-theme-primary bg-theme-background text-theme-on-background flex-1 rounded border px-2 py-1 text-xs focus:outline-none"
			/>
			<button
				class="text-theme-on-surface-variant hover:text-theme-on-surface hover-theme rounded p-1 transition-colors"
				onclick={clearLogs}
				title="清空日志"
				aria-label="清空日志"
			>
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
				>
					<polyline points="3,6 5,6 21,6" />
					<path d="m19,6v14a2,2 0 0,1 -2,2H7a2,2 0 0,1 -2,-2V6m3,0V4a2,2 0 0,1 2,-2h4a2,2 0 0,1 2,2v2"
					/>
				</svg>
			</button>
		</div>
		<div class="text-theme-on-surface-variant mt-1 text-xs">{logs.length} 条日志</div>
	</div>

	<!-- 日志内容 -->
	<div
		class="bg-theme-background flex-1 overflow-y-auto p-2 font-mono text-xs group relative"
		bind:this={logContainer}
		onwheel={(e) => {
			e.stopPropagation();
			if (logContainer) {
				logContainer.scrollTop += e.deltaY;
			}
		}}
	>
		{#each filteredLogs as log (log.id)}
			{@const logId = log.id || ''}
			<div class="mb-1 hover:bg-theme-surface-variant/50 transition-colors {expandedLogs.has(logId) ? 'bg-theme-surface' : ''}"
			>
				<div 
					class="flex items-start gap-2 px-2 py-1 cursor-pointer select-text"
					role="button"
					tabindex="0"
					onclick={() => toggleLogExpanded(logId)}
					onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && toggleLogExpanded(logId)}
					aria-expanded={expandedLogs.has(logId)}
					aria-label="Toggle log details"
				>
					<span class="rounded px-1 py-0 text-[10px] font-medium flex-shrink-0 {getLevelBadgeColor(log.level)}"
					>
						{log.level.substring(0, 3).toUpperCase()}
					</span>
					<span class="text-theme-on-surface-variant text-[10px] flex-shrink-0">{formatTime(log.timestamp)}</span>
					<div class="text-theme-on-surface flex-1 min-w-0">
						<span class="break-words select-text">{log.message}</span>
						{#if log.data && !expandedLogs.has(logId)}
							<span class="text-theme-primary text-[10px] ml-1">▶</span>
						{/if}
					</div>
					<button
						class="text-theme-on-surface-variant hover:text-theme-on-surface text-[10px] px-1 opacity-0 group-hover:opacity-100 transition-opacity"
						onclick={(e) => {
							e.stopPropagation();
							copyToClipboard(`${log.level} ${formatTime(log.timestamp)} ${log.message}${log.data ? '\n' + formatData(log.data) : ''}`);
						}}
						title="复制日志"
					>
						📋
					</button>
				</div>
				{#if log.data && expandedLogs.has(logId)}
					<div class="px-2 pb-2 text-theme-on-surface-variant">
						{#if hasStackTrace(log.data)}
							<div class="space-y-1">
								<div class="bg-theme-error-container/20 text-theme-error rounded p-2">
									<div class="text-[10px] font-semibold mb-1">错误堆栈:</div>
									<pre class="whitespace-pre-wrap text-[10px] select-text">{log.data.stack_trace}</pre>
								</div>
								{#if hasPanicMessage(log.data)}
									<div class="bg-theme-error-container/20 text-theme-error rounded p-2">
										<div class="text-[10px] font-semibold mb-1">Panic:</div>
										<pre class="whitespace-pre-wrap text-[10px] select-text">{log.data.panic_message}</pre>
									</div>
								{/if}
							</div>
						{:else}
							<pre class="bg-theme-surface-variant text-theme-on-surface text-[10px] overflow-x-auto rounded p-1 select-text">{formatData(log.data)}</pre>
						{/if}
					</div>
				{/if}
			</div>
		{/each}

		{#if filteredLogs.length === 0}
			<div class="text-theme-on-surface-variant py-8 text-center">
				{logs.length === 0 ? '暂无日志' : '无符合条件的日志'}
			</div>
		{/if}
	</div>
</div>