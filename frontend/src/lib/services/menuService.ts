import { writable, derived } from 'svelte/store';

interface MenuState {
	fileMenu: boolean;
	editMenu: boolean;
	windowMenu: boolean;
	moreMenu: boolean;
	projectMenu: boolean;
}

function createMenuService() {
	const menuState = writable<MenuState>({
		fileMenu: false,
		editMenu: false,
		windowMenu: false,
		moreMenu: false,
		projectMenu: false
	});

	const hasMenuOpen = derived(menuState, $state => 
		$state.fileMenu || $state.editMenu || $state.windowMenu || $state.moreMenu || $state.projectMenu
	);

	function toggleMenu(menuName: keyof MenuState) {
		menuState.update(state => {
			const newState = {
				fileMenu: false,
				editMenu: false,
				windowMenu: false,
				moreMenu: false,
				projectMenu: false
			};
			newState[menuName] = !state[menuName];
			return newState;
		});
	}

	function openMenu(menuName: keyof MenuState) {
		menuState.update(state => {
			if (state.fileMenu || state.editMenu || state.windowMenu || state.moreMenu || state.projectMenu) {
				return {
					fileMenu: false,
					editMenu: false,
					windowMenu: false,
					moreMenu: false,
					projectMenu: false,
					[menuName]: true
				};
			}
			return state;
		});
	}

	function closeAllMenus() {
		menuState.set({
			fileMenu: false,
			editMenu: false,
			windowMenu: false,
			moreMenu: false,
			projectMenu: false
		});
	}

	return {
		menuState,
		hasMenuOpen,
		toggleMenu,
		openMenu,
		closeAllMenus
	};
}

export const menuService = createMenuService();
export const { menuState, hasMenuOpen } = menuService;