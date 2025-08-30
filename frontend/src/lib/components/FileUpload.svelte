<script lang="ts">
	import { createEventDispatcher, onMount } from 'svelte';
	import { platformService } from '$lib/services/platformService';
	
	export let accept: string = '*';
	export let multiple: boolean = false;
	export let disabled: boolean = false;
	export let fileType: 'image' | 'project' | 'any' = 'any';
	export let selectedFile: File | null = null;
	export let selectedFilePath: string | null = null;
	export let showSelectedFile: boolean = false;
	
	const dispatch = createEventDispatcher();
	
	let fileInput: HTMLInputElement;
	let dropZone: HTMLElement;
	let isDragging = false;
	let isInTauri = false;
	let unlistenDragDrop: (() => void) | null = null;
	
	onMount(() => {
		isInTauri = platformService.isTauri();
		
		// 在Tauri环境中设置文件拖拽监听器
		if (isInTauri) {
			setupTauriFileDrop();
		}
		
		// 清理函数
		return () => {
			if (unlistenDragDrop) {
				unlistenDragDrop();
				unlistenDragDrop = null;
			}
		};
	});
	
	// 设置Tauri文件拖拽监听器
	async function setupTauriFileDrop() {
		try {
			const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
			const { convertFileSrc } = await import('@tauri-apps/api/core');
			const webview = getCurrentWebviewWindow();
			
			// 监听文件拖拽事件
			const unlisten = await webview.onDragDropEvent((event) => {
				if (disabled) return;
				
				// 检查组件是否在DOM中可见
				if (!dropZone || !dropZone.offsetParent) return;
				
				if (event.payload.type === 'drop') {
					// 立即重置拖拽状态，无论如何都要重置
					isDragging = false;
					
					const paths = event.payload.paths;
					
					if (fileType === 'image') {
						const files = paths.map((path: string) => {
							const fileName = path.split('/').pop() || path.split('\\').pop() || 'Unknown';
							const lowerPath = path.toLowerCase();
							if (
								lowerPath.endsWith('.png') ||
								lowerPath.endsWith('.jpg') ||
								lowerPath.endsWith('.jpeg') ||
								lowerPath.endsWith('.gif') ||
								lowerPath.endsWith('.bmp') ||
								lowerPath.endsWith('.webp')
							) {
								return {
									path,
									name: fileName,
									size: 0,
									type: 'image/*',
									url: convertFileSrc(path)
								};
							}
							return null;
						}).filter((f: any) => f !== null);
						
						if (files.length > 0) {
							dispatch('filesSelected', multiple ? files : files.slice(0, 1));
						} else {
							// 如果没有有效的图片文件，显示错误
							dispatch('error', '请选择有效的图片文件 (PNG, JPG, JPEG, GIF, BMP, WebP)');
						}
					} else if (fileType === 'project') {
						if (paths.length > 0) {
							const path = paths[0];
							const fileName = path.split('/').pop() || path.split('\\').pop() || 'Unknown';
							const ext = fileName.split('.').pop()?.toLowerCase();
							
							if (['txt', 'lp', 'bf'].includes(ext || '')) {
								dispatch('fileSelected', {
									path,
									fileName
								});
							} else {
								dispatch('error', '请选择有效的项目文件 (.txt, .lp 或 .bf)');
							}
						}
					} else {
						// 通用文件处理
						const files = paths.map((path: string) => {
							const fileName = path.split('/').pop() || path.split('\\').pop() || 'Unknown';
							return {
								path,
								name: fileName,
								size: 0,
								type: '*',
								url: convertFileSrc(path)
							};
						});
						
						if (files.length > 0) {
							dispatch('filesSelected', multiple ? files : files.slice(0, 1));
						}
					}
				} else if (event.payload.type === 'over') {
					// 只有在组件可见时才设置拖拽状态
					if (dropZone && dropZone.offsetParent) {
						isDragging = true;
					}
				} else if (event.payload.type === 'leave') {
					isDragging = false;
				}
			});
			
			// 保存清理函数
			unlistenDragDrop = unlisten;
		} catch (error) {
			console.error('Failed to setup Tauri file drop:', error);
		}
	}
	
	function handleFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		if (input.files && input.files.length > 0) {
			if (fileType === 'project') {
				const file = input.files[0];
				const ext = file.name.split('.').pop()?.toLowerCase();
				
				if (!['txt', 'lp', 'bf'].includes(ext || '')) {
					dispatch('error', '请选择有效的项目文件 (.txt, .lp 或 .bf)');
					return;
				}
				
				dispatch('fileSelected', { file });
			} else {
				processFiles(input.files);
			}
		}
	}
	
	function handleDrop(event: DragEvent) {
		event.preventDefault();
		isDragging = false;
		
		if (disabled) return;
		
		// 在Tauri环境中，拖拽已经通过原生事件处理
		if (isInTauri) return;
		
		const files = event.dataTransfer?.files;
		if (files && files.length > 0) {
			if (fileType === 'project') {
				const file = files[0];
				const ext = file.name.split('.').pop()?.toLowerCase();
				
				if (!['txt', 'lp', 'bf'].includes(ext || '')) {
					dispatch('error', '请选择有效的项目文件 (.txt, .lp 或 .bf)');
					return;
				}
				
				dispatch('fileSelected', { file });
			} else {
				processFiles(files);
			}
		}
	}
	
	function handleDragOver(event: DragEvent) {
		event.preventDefault();
		// 在Tauri环境中，拖拽状态已经通过原生事件处理
		if (!disabled && !isInTauri) {
			isDragging = true;
		}
	}
	
	function handleDragLeave(event: DragEvent) {
		event.preventDefault();
		// 在Tauri环境中，拖拽状态已经通过原生事件处理
		if (!isInTauri) {
			isDragging = false;
		}
	}
	
	function processFiles(fileList: FileList) {
		const files = Array.from(fileList).map(file => ({
			file,
			name: file.name,
			size: file.size,
			type: file.type
		}));
		
		dispatch('filesSelected', multiple ? files : files.slice(0, 1));
	}
	
	async function openFileDialog() {
		if (disabled) return;
		
		// 在Tauri环境中使用原生文件选择器
		if (isInTauri) {
			try {
				if (fileType === 'image') {
					const { invoke } = await import('@tauri-apps/api/core');
					const { convertFileSrc } = await import('@tauri-apps/api/core');
					
					if (multiple) {
						const filePaths = await invoke<string[] | null>('open_multiple_image_files_dialog');
						if (filePaths && filePaths.length > 0) {
							const files = filePaths.map(path => {
								const fileName = path.split('/').pop() || path.split('\\').pop() || 'Unknown';
								return {
									path,
									name: fileName,
									size: 0,
									type: 'image/*',
									url: convertFileSrc(path)
								};
							});
							dispatch('filesSelected', files);
						}
					} else {
						const filePath = await invoke<string | null>('open_image_file_dialog');
						if (filePath) {
							const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'Unknown';
							dispatch('filesSelected', [{
								path: filePath,
								name: fileName,
								size: 0,
								type: 'image/*',
								url: convertFileSrc(filePath)
							}]);
						}
					}
				} else if (fileType === 'project') {
					const filePath = await platformService.openProjectFileDialog();
					if (filePath) {
						const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'Unknown';
						dispatch('fileSelected', {
							path: filePath,
							fileName
						});
					}
				} else {
					// 通用文件选择，回退到HTML输入
					fileInput?.click();
				}
			} catch (error) {
				console.error('Failed to open native dialog, falling back to HTML input:', error);
				if (fileType === 'project') {
					dispatch('error', '选择文件失败');
				} else {
					fileInput?.click();
				}
			}
		} else {
			// Web环境使用HTML文件输入
			fileInput?.click();
		}
	}
	// 获取正确的accept属性
	$: computedAccept = fileType === 'project' ? '.bf,.txt,.lp' : 
	                   fileType === 'image' ? 'image/*' : 
	                   accept;
	
	// 获取按钮文本
	$: buttonText = fileType === 'project' ? '点击选择项目文件' : 
	               fileType === 'image' ? '选择图片' : 
	               '选择文件';
	
	// 获取提示文本
	$: hintText = fileType === 'project' ? '支持格式：.bf, .txt, .lp' : 
	             fileType === 'image' ? '支持格式：PNG, JPG, GIF, WebP, BMP' : 
	             '';
</script>

<div class="space-y-4">
	<!-- 文件选择区域 -->
	<div
		bind:this={dropZone}
		role="button"
		tabindex="0"
		aria-label="选择或拖拽文件"
		class="relative border-2 border-dashed rounded-lg p-8 text-center transition-all duration-200 cursor-pointer
			{isDragging 
				? 'border-theme-primary bg-theme-primary-container/20 scale-[1.02]' 
				: 'border-theme-outline bg-theme-surface hover:bg-theme-surface-variant hover:border-theme-outline'}
			{disabled ? 'opacity-50 cursor-not-allowed' : ''}"
		style="border-color: {isDragging ? 'var(--color-primary)' : 'var(--color-outline)'}"
		on:drop={handleDrop}
		on:dragover={handleDragOver}
		on:dragleave={handleDragLeave}
		on:click={openFileDialog}
		on:keydown={(e) => e.key === 'Enter' && openFileDialog()}
	>
		<input
			bind:this={fileInput}
			type="file"
			accept={computedAccept}
			{multiple}
			{disabled}
			on:change={handleFileSelect}
			class="absolute -left-[9999px]"
		/>
		
		<div class="flex flex-col items-center gap-3 pointer-events-none">
			<!-- 图标 -->
			<div class="w-16 h-16 rounded-full bg-theme-primary/10 flex items-center justify-center">
				{#if fileType === 'project'}
					<svg class="w-8 h-8 text-theme-primary" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" />
					</svg>
				{:else if fileType === 'image'}
					<svg class="w-8 h-8 text-theme-primary" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
					</svg>
				{:else}
					<svg class="w-8 h-8 text-theme-primary" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m6.75 12l-3-3m0 0l-3 3m3-3v6m-1.5-15H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
					</svg>
				{/if}
			</div>
			
			<!-- 文字提示 -->
			<div>
				<p class="text-theme-on-surface font-medium mb-1">
					{isDragging ? '松开以选择文件' : buttonText}
				</p>
				<p class="text-sm text-theme-on-surface-variant">
					或将文件拖拽到此处
				</p>
				{#if hintText}
					<p class="text-xs text-theme-on-surface-variant mt-2">
						{hintText}
					</p>
				{/if}
			</div>
		</div>
	</div>
	
	<!-- 已选择的文件显示 -->
	{#if showSelectedFile && (selectedFile || selectedFilePath)}
		<div class="flex items-center gap-3 p-3 bg-theme-primary-container/30 rounded-lg">
			<div class="w-10 h-10 rounded-full bg-theme-primary/20 flex items-center justify-center flex-shrink-0">
				<svg class="w-5 h-5 text-theme-primary" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
				</svg>
			</div>
			<div class="flex-1 min-w-0">
				<p class="text-sm font-medium text-theme-on-surface truncate">
					{selectedFile?.name || selectedFilePath?.split(/[\\/]/).pop()}
				</p>
				{#if selectedFilePath}
					<p class="text-xs text-theme-on-surface-variant truncate" title={selectedFilePath}>
						{selectedFilePath}
					</p>
				{/if}
			</div>
		</div>
	{/if}
</div>

