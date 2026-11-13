<script lang="ts">
	const { size = 48, color = 'currentColor' } = $props<{
		size?: number;
		color?: string;
	}>();
</script>

<div class="loading-spinner-container">
	<svg
		width={size}
		height={size}
		viewBox="0 0 50 50"
		xmlns="http://www.w3.org/2000/svg"
		class="loading-spinner"
	>
		<circle
			cx="25"
			cy="25"
			r="20"
			fill="none"
			stroke={color}
			stroke-width="4"
			stroke-linecap="round"
			stroke-dasharray="80 40"
			opacity="0.3"
		/>
		<circle
			cx="25"
			cy="25"
			r="20"
			fill="none"
			stroke={color}
			stroke-width="4"
			stroke-linecap="round"
			stroke-dasharray="40 85"
			class="spinner-arc"
		/>
	</svg>
	<p class="text-sm text-gray-500 mt-2">加载中...</p>
</div>

<style>
	.loading-spinner-container {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 20px;
		background: rgba(255, 255, 255, 0.9);
		border-radius: 8px;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
	}

	.loading-spinner {
		animation: rotate 1.5s linear infinite;
	}

	.spinner-arc {
		animation: dash 1.5s ease-in-out infinite;
		transform-origin: center;
	}

	@keyframes rotate {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes dash {
		0% {
			stroke-dasharray: 1 125;
			stroke-dashoffset: 0;
		}
		50% {
			stroke-dasharray: 80 45;
			stroke-dashoffset: -35;
		}
		100% {
			stroke-dasharray: 1 125;
			stroke-dashoffset: -125;
		}
	}
</style>