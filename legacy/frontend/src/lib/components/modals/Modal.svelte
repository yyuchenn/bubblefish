<script lang="ts">
	
	// Props
	const {
		visible = false,
		onClose = () => {},
		children
	} = $props<{
		visible?: boolean;
		onClose?: () => void;
		children?: any;
	}>();

	function close() {
		onClose();
	}
	
	$effect(() => {
		if (visible) {
			const handleKeydown = (e: KeyboardEvent) => {
				if (e.key === 'Escape') {
					close();
				}
			};
			
			document.addEventListener('keydown', handleKeydown);
			
			return () => {
				document.removeEventListener('keydown', handleKeydown);
			};
		}
		return undefined;
	});
</script>

{#if visible}
	<div
		class="fixed top-0 right-0 bottom-0 left-0 z-[1100] flex items-center justify-center bg-black/40 border-0 p-0"
		onclick={close}
		onkeydown={(e) => e.key === 'Escape' && close()}
		role="button"
		tabindex="-1"
		aria-label="Close modal"
	>
		<div
			class="bg-theme-background max-h-[85vh] max-w-[90vw] overflow-auto rounded-lg p-6 shadow-xl cursor-auto"
			data-modal-content
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.key === 'Escape' && close()}
			role="dialog"
			aria-modal="true"
			tabindex="-1"
		>
			{@render children?.()}
		</div>
	</div>
{/if}
