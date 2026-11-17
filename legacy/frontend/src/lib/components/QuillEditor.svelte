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


	// Expose a function to imperatively set the value
	// cursorPosition: 'end' = 移到末尾, 'preserve' = 保持当前位置, 'afterChange' = 移到变化内容之后, number = 指定位置
	// oldValue: 用于计算变化位置（仅在 cursorPosition 为 'afterChange' 时使用）
	export function setValue(newValue: string, cursorPosition: 'end' | 'preserve' | 'afterChange' | number = 'preserve', oldValue?: string) {
		if (quillEditor) {
			isInternalUpdate = true;
			// 保存当前光标位置
			const currentSelection = quillEditor.getSelection();
			// 解析Bubblefish文本并设置内容
			const delta = bubblefishText2quillDelta(newValue);
			quillEditor.setContents(delta);
			// 根据参数设置光标位置
			const length = quillEditor.getLength();
			
			if (cursorPosition === 'end') {
				// 移到末尾
				quillEditor.setSelection(length - 1, 0);
				// 聚焦编辑器
				quillEditor.focus();
			} else if (cursorPosition === 'preserve') {
				// 保持原位置（如果有效）
				if (currentSelection && currentSelection.index < length) {
					quillEditor.setSelection(currentSelection.index, 0);
				} else {
					quillEditor.setSelection(length - 1, 0);
				}
			} else if (cursorPosition === 'afterChange' && oldValue !== undefined) {
				// 计算变化位置并移动光标到变化内容之后
				const changePos = findChangePosition(oldValue, newValue);
				// 设置光标到变化内容的末尾
				const targetIndex = Math.min(changePos.endPos, length - 1);
				quillEditor.setSelection(targetIndex, 0);
			} else if (typeof cursorPosition === 'number') {
				// 移到指定位置
				const validIndex = Math.min(Math.max(0, cursorPosition), length - 1);
				quillEditor.setSelection(validIndex, 0);
			}
			
			isInternalUpdate = false;
		}
	}
	
	// 辅助函数：查找两个字符串之间的变化位置
	function findChangePosition(oldStr: string, newStr: string): { startPos: number; endPos: number } {
		// 找到第一个不同的位置
		let startPos = 0;
		const minLen = Math.min(oldStr.length, newStr.length);
		while (startPos < minLen && oldStr[startPos] === newStr[startPos]) {
			startPos++;
		}
		
		// 如果新字符串更长，变化结束位置是新字符串的相应位置
		if (newStr.length >= oldStr.length) {
			// 插入或替换：光标移到新内容的末尾
			const lengthDiff = newStr.length - oldStr.length;
			return { startPos, endPos: startPos + lengthDiff + 1 };
		} else {
			// 删除：光标移到删除位置
			return { startPos, endPos: startPos };
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
	
	/* Quill editor font size and color */
	:global(.ql-editor) {
		font-size: 1rem !important; /* Tailwind's text-base */
		line-height: 1.5rem !important;
		color: var(--color-on-surface) !important; /* Use theme color */
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