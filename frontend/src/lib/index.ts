// place files you want to import through the `$lib` alias in this folder.

// 导出服务
export * from './services/imageService';
export * from './services/imageLoaderService';
export * from './services/markerService';
export * from './services/imageViewerService';
export * from './services/projectService';

// 导出工具
export * from './utils/validation';
export * from './utils/imageUtils';
export * from './utils/progressManager';
export * from './utils/sharedArrayBufferStream';
export * from './utils/sharedArrayBufferImageLoader';

// 导出存储
export * from './stores/projectStore';
export * from './stores/modalStore';
export * from './stores/errorStore';
export * from './stores/loadingStore';
export { imageStore } from './stores/imageStore';
export { markerStore } from './stores/markerStore';
export * from './stores/imageViewerStore';
export * from './stores/layoutStore';
export * from './stores/logViewerStore';
export * from './stores/themeStore';

// 导出核心功能
export * from './core/adapter';
export * from './core/events';
export * from './core/tauri';
export * from './types';

// 导出组件（可选，如果需要在其他地方重用）
export { default as ButtonBar } from './components/ButtonBar.svelte';
export { default as ContextMenu } from './components/ContextMenu.svelte';
export { default as ImageViewer } from './components/ImageViewer.svelte';
export { default as LoadingSpinner } from './components/LoadingSpinner.svelte';
export { default as Modal } from './components/modals/Modal.svelte';
export { default as ProgressBar } from './components/ProgressBar.svelte';
export { default as StatusBar } from './components/StatusBar.svelte';
