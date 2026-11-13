import { writable, derived } from 'svelte/store';
import { tauriAPI, type Platform } from '$lib/core/tauri';

// 布局相关配置接口
export interface LayoutConfig {
	// 标题栏高度 (像素)
	titleBarHeight: number;
	// 面板标题栏高度 (像素) - 用于各种面板的标题栏
	panelTitleBarHeight: number;
	// 状态栏高度 (像素)
	statusBarHeight: number;
}

// 边栏状态接口
export interface SidebarState {
	leftSidebarOpen: boolean;
	bottomPanelOpen: boolean;
	rightSidebarOpen: boolean;
	// 边栏大小记录 (像素)
	leftSidebarWidth: number;
	bottomPanelHeight: number;
	rightSidebarWidth: number;
	// 当前选中的左侧边栏类型（保持状态，即使关闭）
	leftSidebarType: 'images' | 'dictionary' | 'projectSettings';
}

// 平台特定的布局配置
const platformConfigs: Record<Platform, LayoutConfig> = {
	macos: {
		titleBarHeight: 28, // h-7
		panelTitleBarHeight: 32, // h-8
		statusBarHeight: 24
	},
	windows: {
		titleBarHeight: 32, // h-8
		panelTitleBarHeight: 32, // h-8
		statusBarHeight: 24
	},
	linux: {
		titleBarHeight: 40, // h-10
		panelTitleBarHeight: 32, // h-8
		statusBarHeight: 24
	},
	unknown: {
		titleBarHeight: 32, // h-8 默认值
		panelTitleBarHeight: 32, // h-8
		statusBarHeight: 24
	}
};

// 当前平台
export const currentPlatform = writable<Platform>('unknown');

// 当前布局配置
export const layoutConfig = derived(currentPlatform, ($platform) => platformConfigs[$platform]);

// 边栏状态管理
export const sidebarState = writable<SidebarState>({
	leftSidebarOpen: false,
	bottomPanelOpen: false,
	rightSidebarOpen: true,  // 默认打开右边栏
	// 默认边栏大小
	leftSidebarWidth: 280,
	bottomPanelHeight: 240,
	rightSidebarWidth: 350,
	leftSidebarType: 'images'  // 默认为 images 类型
});

// 初始化平台检测
function initializePlatform() {
	try {
		const platform = tauriAPI.getPlatform();
		currentPlatform.set(platform);
	} catch (error) {
		console.warn('Failed to detect platform, using default config:', error);
		currentPlatform.set('unknown');
	}
}

// 持久化键名
const LAYOUT_STORAGE_KEY = 'sidebarState';

// 布局相关的动作
export const layoutActions = {
	// 手动设置平台（用于测试）
	setPlatform: (platform: Platform) => {
		currentPlatform.set(platform);
	},

	// 重新检测平台
	detectPlatform: () => {
		initializePlatform();
	},

	// 获取当前配置
	getCurrentConfig: (): LayoutConfig => {
		let config: LayoutConfig;
		layoutConfig.subscribe((value) => (config = value))();
		return config!;
	},

	// 保存侧边栏状态到 localStorage
	saveSidebarState: () => {
		sidebarState.subscribe(state => {
			localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(state));
		})();
	},

	// 从 localStorage 加载侧边栏状态
	loadSavedSidebarState: () => {
		const saved = localStorage.getItem(LAYOUT_STORAGE_KEY);
		if (saved) {
			try {
				const state = JSON.parse(saved) as SidebarState;
				sidebarState.set(state);
			} catch (error) {
				console.error('Failed to load saved sidebar state:', error);
			}
		}
	},

	// 切换左边栏
	toggleLeftSidebar: () => {
		sidebarState.update(state => ({
			...state,
			leftSidebarOpen: !state.leftSidebarOpen
		}));
		layoutActions.saveSidebarState();
	},

	// 切换底部面板
	toggleBottomPanel: () => {
		sidebarState.update(state => ({
			...state,
			bottomPanelOpen: !state.bottomPanelOpen
		}));
		layoutActions.saveSidebarState();
	},

	// 切换右边栏
	toggleRightSidebar: () => {
		sidebarState.update(state => ({
			...state,
			rightSidebarOpen: !state.rightSidebarOpen
		}));
		layoutActions.saveSidebarState();
	},

	// 设置左边栏状态
	setLeftSidebar: (open: boolean) => {
		sidebarState.update(state => ({
			...state,
			leftSidebarOpen: open
		}));
		layoutActions.saveSidebarState();
	},

	// 设置底部面板状态
	setBottomPanel: (open: boolean) => {
		sidebarState.update(state => ({
			...state,
			bottomPanelOpen: open
		}));
		layoutActions.saveSidebarState();
	},

	// 设置右边栏状态
	setRightSidebar: (open: boolean) => {
		sidebarState.update(state => ({
			...state,
			rightSidebarOpen: open
		}));
		layoutActions.saveSidebarState();
	},

	// 设置左边栏宽度
	setLeftSidebarWidth: (width: number) => {
		sidebarState.update(state => ({
			...state,
			leftSidebarWidth: width
		}));
		layoutActions.saveSidebarState();
	},

	// 设置底部面板高度
	setBottomPanelHeight: (height: number) => {
		sidebarState.update(state => ({
			...state,
			bottomPanelHeight: height
		}));
		layoutActions.saveSidebarState();
	},

	// 设置右边栏宽度
	setRightSidebarWidth: (width: number) => {
		sidebarState.update(state => ({
			...state,
			rightSidebarWidth: width
		}));
		layoutActions.saveSidebarState();
	},

	// 打开左边栏并保持原有宽度
	openLeftSidebar: (width?: number) => {
		sidebarState.update(state => ({
			...state,
			leftSidebarOpen: true,
			...(width !== undefined && { leftSidebarWidth: width })
		}));
		layoutActions.saveSidebarState();
	},

	// 打开底部面板并保持原有高度
	openBottomPanel: (height?: number) => {
		sidebarState.update(state => ({
			...state,
			bottomPanelOpen: true,
			...(height !== undefined && { bottomPanelHeight: height })
		}));
		layoutActions.saveSidebarState();
	},

	// 打开右边栏并保持原有宽度
	openRightSidebar: (width?: number) => {
		sidebarState.update(state => ({
			...state,
			rightSidebarOpen: true,
			...(width !== undefined && { rightSidebarWidth: width })
		}));
		layoutActions.saveSidebarState();
	},

	// 关闭左边栏但保留宽度设置
	closeLeftSidebar: () => {
		sidebarState.update(state => ({
			...state,
			leftSidebarOpen: false
		}));
		layoutActions.saveSidebarState();
	},

	// 关闭底部面板但保留高度设置
	closeBottomPanel: () => {
		sidebarState.update(state => ({
			...state,
			bottomPanelOpen: false
		}));
		layoutActions.saveSidebarState();
	},

	// 关闭右边栏但保留宽度设置
	closeRightSidebar: () => {
		sidebarState.update(state => ({
			...state,
			rightSidebarOpen: false
		}));
		layoutActions.saveSidebarState();
	},

	// 切换左侧边栏类型
	toggleLeftSidebarType: (type: 'images' | 'dictionary' | 'projectSettings') => {
		sidebarState.update(state => {
			// 如果点击当前已选中的类型，则关闭边栏
			if (state.leftSidebarType === type && state.leftSidebarOpen) {
				return {
					...state,
					leftSidebarOpen: false
					// 保持 leftSidebarType 不变，以便记住状态
				};
			}
			// 否则打开边栏并设置类型
			return {
				...state,
				leftSidebarOpen: true,
				leftSidebarType: type
			};
		});
		layoutActions.saveSidebarState();
	},

	// 简单切换左边栏开关（用于TitleBar）
	toggleLeftSidebarSimple: () => {
		sidebarState.update(state => {
			// 简单地切换开关状态，保持类型不变
			return {
				...state,
				leftSidebarOpen: !state.leftSidebarOpen
			};
		});
		layoutActions.saveSidebarState();
	}
};

// 浏览器环境下自动初始化
if (typeof window !== 'undefined') {
	initializePlatform();
	// 自动加载保存的侧边栏状态
	layoutActions.loadSavedSidebarState();
}
