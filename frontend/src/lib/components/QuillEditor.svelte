<script lang="ts">
	import { onMount } from 'svelte';
	import type Quill from 'quill';
	import { quillDelta2bubblefishText, bubblefishText2quillDelta } from '$lib/services/textService';
	import { undoRedoService } from '$lib/services/undoRedoService';
	import ContextMenu from './ContextMenu.svelte';

	// Custom emphasis blot class - declared at top level for performance
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let EmphasisBlot: any = null;

	// Props (runes) with explicit onchange callback
	let {
		value = '',
		disabled = false,
		onchange = (_v: string) => {},
		onblur = () => {}
	} = $props<{
		value?: string;
		disabled?: boolean;
		onchange?: (v: string) => void;
		onblur?: () => void;
	}>();

	let container: HTMLDivElement;
	let editorWrapper: HTMLDivElement;
	let quillEditor = $state<Quill | null>(null);
	let isInternalUpdate = false;

	// 获取当前主题的文字颜色
	function getThemeTextColor(): string {
		// 先尝试从container元素获取，如果没有则从document获取
		const element = container || document.documentElement;
		const computedStyle = getComputedStyle(element);
		const color = computedStyle.getPropertyValue('--color-on-surface').trim();
		// 如果CSS变量不存在，尝试获取计算后的color属性
		return color || computedStyle.color || '#000000';
	}


	// Expose a function to imperatively set the value
	export function setValue(newValue: string) {
		if (quillEditor) {
			isInternalUpdate = true;
			// 保存当前光标位置
			const currentSelection = quillEditor.getSelection();
			// 解析Bubblefish文本并设置内容
			const delta = bubblefishText2quillDelta(newValue);
			quillEditor.setContents(delta);
			// 设置文字颜色
			const textColor = getThemeTextColor();
			const length = quillEditor.getLength();
			quillEditor.setSelection(0, length);
			quillEditor.format('color', textColor);
			// 恢复光标位置或移到末尾
			if (currentSelection && currentSelection.index < length) {
				quillEditor.setSelection(currentSelection.index, 0);
			} else {
				quillEditor.setSelection(length - 1, 0);
			}
			isInternalUpdate = false;
		}
	}

	// Expose a function to focus the editor and move cursor to end
	export function focusEnd() {
		if (quillEditor) {
			// Focus the editor
			quillEditor.focus();
			// Move cursor to the end of the text
			const length = quillEditor.getLength();
			quillEditor.setSelection(length - 1, 0);
		}
	}

	// Context menu state
	let contextMenuVisible = $state(false);
	let contextMenuX = $state(0);
	let contextMenuY = $state(0);
	let contextMenuItems = $state<Array<{ label: string; action: () => void; disabled?: boolean }>>([]);

	onMount(() => {
		let disposed = false;
		const cleanupFns: Array<() => void> = [];

		// Import Quill dynamically to avoid SSR issues
		import('quill').then((QuillModule) => {
			if (disposed) return;

			const Quill = QuillModule.default;

			// Import Quill styles
			import('quill/dist/quill.snow.css');
			
			// Define custom icon for emphasis button
			const icons = Quill.import('ui/icons') as Record<string, string>;
			icons['emphasis'] = '<svg viewBox="0 0 18 18"><path class="ql-fill" d="M5 12L7.5 4H10.5L13 12H11L10.5 10H7.5L7 12H5ZM8 8H10L9 5L8 8Z"/><circle cx="9" cy="15" r="1.5" class="ql-fill"/></svg>';

			// Register custom emphasis format
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const Inline = Quill.import('blots/inline') as any;
			if (!EmphasisBlot) {
				EmphasisBlot = class extends Inline {
					static blotName = 'emphasis';
					static tagName = 'span';
					static className = 'ql-emphasis';
					
					static create(value?: boolean) {
						const node = super.create(value);
						node.setAttribute('class', 'ql-emphasis');
						return node;
					}

					static formats(node: HTMLElement) {
						return node.classList.contains('ql-emphasis');
					}
				};
			}
			Quill.register(EmphasisBlot, true);

			// Create Quill instance in the wrapper
			const editor = new Quill(editorWrapper, {
				theme: 'snow',
				placeholder: '输入翻译...',
				modules: {
					toolbar: [
						['bold', 'italic', 'strike', 'emphasis'] // 显示加粗、斜体、删除线和着重点按钮
					],
					history: {
						// 禁用 Quill 的内置撤销重做功能
						delay: Infinity,
						maxStack: 0,
						userOnly: false
					},
					keyboard: {
						bindings: {
							// 覆盖默认的撤销快捷键
							undo: {
								key: 'Z',
								shortKey: true,
								handler: async function() {
									await undoRedoService.undo();
									return false; // 阻止默认行为
								}
							},
							// 覆盖默认的重做快捷键 (Ctrl+Y 和 Ctrl+Shift+Z)
							redo: {
								key: 'Y',
								shortKey: true,
								handler: async function() {
									await undoRedoService.redo();
									return false; // 阻止默认行为
								}
							},
							redoAlt: {
								key: 'Z',
								shortKey: true,
								shiftKey: true,
								handler: async function() {
									await undoRedoService.redo();
									return false; // 阻止默认行为
								}
							},
							// 阻止 Tab 键的默认行为（插入制表符）
							tab: {
								key: 'Tab',
								handler: function() {
									// 返回 false 阻止默认的 Tab 插入行为
									// Tab 切换 marker 的逻辑已经在 GlobalKeyboardShortcuts 中处理
									return false;
								}
							},
							// 阻止 Shift+Tab 键的默认行为
							shiftTab: {
								key: 'Tab',
								shiftKey: true,
								handler: function() {
									// 返回 false 阻止默认行为
									return false;
								}
							}
						}
					}
				},
				formats: ['bold', 'italic', 'strike', 'emphasis'] // 允许加粗、斜体、删除线和着重点格式
			});


			// Set initial value
			if (value) {
				isInternalUpdate = true;
				const delta = bubblefishText2quillDelta(value);
				editor.setContents(delta);
				isInternalUpdate = false;
			}

			// 设置初始文字颜色
			const textColor = getThemeTextColor();
			editor.format('color', textColor);

			// 移动工具栏到外部容器
			const toolbar = editorWrapper.querySelector('.ql-toolbar');
			if (toolbar && container) {
				// 从原位置移除工具栏
				toolbar.remove();
				// 添加到容器顶部
				// eslint-disable-next-line svelte/no-dom-manipulating
				container.insertBefore(toolbar, editorWrapper);
			}

			// 编辑器样式
			const qlEditor = editorWrapper.querySelector('.ql-editor') as HTMLElement;
			if (qlEditor) {
				qlEditor.classList.add('p-3', 'text-base');
			}



			// Handle text changes
			editor.on('text-change', (_delta, _oldDelta, source) => {
				if (!isInternalUpdate && source === 'user') {
					// 只有用户输入时才触发onChange
					const bubblefishText = quillDelta2bubblefishText(editor);
					onchange(bubblefishText);
				}
			});

			// Handle blur event
			editor.on('selection-change', (range) => {
				if (!range) {
					onblur();
				}
			});

			// Handle disabled state
			editor.enable(!disabled);
			
			// Add context menu for text selection
			if (qlEditor) {
				const handleContextMenu = (e: Event) => {
					const mouseEvent = e as MouseEvent;
					mouseEvent.preventDefault();
					mouseEvent.stopPropagation();
					
					const selection = editor.getSelection();
					if (selection) {
						const hasSelection = selection.length > 0;
						const selectedText = hasSelection ? editor.getText(selection.index, selection.length) : '';
						
						contextMenuItems = [
							{
								label: '复制',
								action: () => {
									if (hasSelection) {
										navigator.clipboard.writeText(selectedText);
									}
									contextMenuVisible = false;
								},
								disabled: !hasSelection
							},
							{
								label: '剪切',
								action: () => {
									if (hasSelection) {
										navigator.clipboard.writeText(selectedText);
										editor.deleteText(selection.index, selection.length);
										// 手动触发更新
										const bubblefishText = quillDelta2bubblefishText(editor);
										onchange(bubblefishText);
									}
									contextMenuVisible = false;
								},
								disabled: !hasSelection
							},
							{
								label: '粘贴',
								action: async () => {
									try {
										const text = await navigator.clipboard.readText();
										if (hasSelection) {
											editor.deleteText(selection.index, selection.length);
										}
										editor.insertText(selection.index, text);
										// 手动触发更新
										const bubblefishText = quillDelta2bubblefishText(editor);
										onchange(bubblefishText);
									} catch (err) {
										console.error('Failed to read clipboard:', err);
									}
									contextMenuVisible = false;
								}
							}
						];
						
						contextMenuX = mouseEvent.clientX;
						contextMenuY = mouseEvent.clientY;
						contextMenuVisible = true;
					}
				};
				
				qlEditor.addEventListener('contextmenu', handleContextMenu);
				cleanupFns.push(() => qlEditor.removeEventListener('contextmenu', handleContextMenu));
			}
			
			// 监听主题变化
			const observer = new MutationObserver(() => {
				if (editor) {
					isInternalUpdate = true; // 防止触发onChange
					const textColor = getThemeTextColor();
					// 保存当前内容和光标位置
					const currentSelection = editor.getSelection();
					const currentLength = editor.getLength();
					
					// 选择所有内容并设置颜色
					editor.setSelection(0, currentLength);
					editor.format('color', textColor);
					
					// 恢复光标位置
					if (currentSelection) {
						editor.setSelection(currentSelection);
					}
					isInternalUpdate = false;
				}
			});

			// 监听document的class变化（通常主题切换会改变class）
			observer.observe(document.documentElement, {
				attributes: true,
				attributeFilter: ['class', 'data-theme']
			});
			
			// 在组件销毁时断开观察
			cleanupFns.push(() => observer.disconnect());
			
			// Assign editor to state variable
			quillEditor = editor;
		});
		
		return () => {
			disposed = true;
			cleanupFns.forEach(fn => fn());
		};
	});

	// Effect to handle disabled state changes
	$effect(() => {
		if (quillEditor) {
			quillEditor.enable(!disabled);
		}
	});
</script>

<!-- Root container with proper flex layout -->
<div
	bind:this={container}
	class="quill-wrapper h-full w-full flex flex-col overflow-hidden text-theme-on-surface {disabled ? 'pointer-events-none opacity-60' : ''}"
>
	<!-- Toolbar will be moved here by JavaScript -->
	<!-- Editor wrapper with scroll -->
	<div bind:this={editorWrapper} class="flex-1 overflow-y-auto overflow-x-hidden min-h-0" onwheel={(e) => e.stopPropagation()}></div>
</div>

<!-- Context Menu -->
<ContextMenu
	visible={contextMenuVisible}
	x={contextMenuX}
	y={contextMenuY}
	items={contextMenuItems}
	onclose={() => contextMenuVisible = false}
/>

<style>
	/* Quill toolbar styles when moved to container */
	:global(.quill-wrapper > .ql-toolbar) {
		flex-shrink: 0;
		border-bottom: 1px solid var(--color-outline);
	}
	
	/* Remove border from container when toolbar is moved */
	:global(.quill-wrapper .ql-container) {
		border: none;
	}
	
	/* Quill toolbar button styles */
	:global(.ql-toolbar button) {
		color: var(--color-on-surface-variant) !important;
		border-radius: 0.25rem !important;
	}
	:global(.ql-toolbar button .ql-stroke) {
		stroke: var(--color-on-surface-variant) !important;
	}
	:global(.ql-toolbar button .ql-fill) {
		fill: var(--color-on-surface-variant) !important;
	}
	:global(.ql-toolbar button:hover:not(.ql-active)) {
		background-color: var(--color-surface) !important;
	}
	:global(.ql-toolbar button:hover:not(.ql-active) .ql-stroke) {
		stroke: var(--color-on-surface-variant) !important;
	}
	:global(.ql-toolbar button:hover:not(.ql-active) .ql-fill) {
		fill: var(--color-on-surface-variant) !important;
	}
	:global(.ql-toolbar button.ql-active) {
		background-color: var(--color-primary) !important;
		color: var(--color-on-primary) !important;
	}
	:global(.ql-toolbar button.ql-active .ql-stroke) {
		stroke: var(--color-on-primary) !important;
	}
	:global(.ql-toolbar button.ql-active .ql-fill) {
		fill: var(--color-on-primary) !important;
	}
	
	/* Quill editor font size */
	:global(.ql-editor) {
		font-size: 1rem !important; /* Tailwind's text-base */
		line-height: 1.5rem !important;
	}
	
	/* Quill placeholder styles to follow theme */
	:global(.ql-editor.ql-blank::before) {
		color: var(--color-on-surface-variant) !important;
		opacity: 0.6;
		font-size: 1rem !important; /* Match editor font size */
	}
	
	/* Emphasis dots style */
	:global(.ql-emphasis) {
		position: relative;
		display: inline;
		text-emphasis: filled dot;
		text-emphasis-position: under;
		-webkit-text-emphasis: filled dot;
		-webkit-text-emphasis-position: under;
	}
</style>