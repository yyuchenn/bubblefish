<script lang="ts">
	import Modal from './Modal.svelte';

	const {
		visible = false,
		title = '确认',
		message = '',
		confirmText = '确认',
		cancelText = '取消',
		onConfirm = () => {},
		onCancel = () => {}
	} = $props<{
		visible?: boolean;
		title?: string;
		message?: string;
		confirmText?: string;
		cancelText?: string;
		onConfirm?: () => void;
		onCancel?: () => void;
	}>();

	function handleConfirm() {
		onConfirm();
	}

	function handleCancel() {
		onCancel();
	}
</script>

<Modal {visible} onClose={handleCancel}>
	<div class="flex flex-col w-[400px]">
		<h2 class="text-theme-on-surface text-xl font-semibold mb-4">{title}</h2>
		<p class="text-theme-on-surface-variant text-sm mb-6">{message}</p>
		<div class="flex gap-4 justify-end">
			<button
				class="bg-theme-primary text-theme-on-primary cursor-pointer rounded border-none px-4 py-1.5 transition-opacity hover:opacity-80"
				onclick={handleCancel}
			>
				{cancelText}
			</button>
			<button
				class="bg-theme-secondary text-theme-on-secondary cursor-pointer rounded border-none px-4 py-1.5 transition-opacity hover:opacity-80"
				onclick={handleConfirm}
			>
				{confirmText}
			</button>
		</div>
	</div>
</Modal>