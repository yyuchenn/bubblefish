<script lang="ts">
	
</script>

<!-- 词库面板组件 -->
<div class="flex h-full flex-col bg-theme-surface">
	<!-- 面板标题栏 -->
	<div class="flex h-8 items-center justify-between border-b border-theme-outline bg-theme-surface-variant px-3">
		<span class="text-sm font-medium text-theme-on-surface select-none">词库</span>
		<!-- 可以在这里添加工具按钮 -->
		<div class="flex items-center gap-1">
			<!-- 占位符，以后可以添加搜索、过滤等功能 -->
		</div>
	</div>
	
	<!-- 面板内容区域 -->
	<div class="flex-1 overflow-y-auto p-4">
		<div class="flex flex-col items-center justify-center h-full text-center">
			<svg class="w-16 h-16 mb-4 text-theme-on-surface-variant opacity-50" viewBox="0 0 512 512" fill="currentColor">
				<path d="M511.414,217.728c-1.902-9.034-8.242-16.503-16.852-19.856l-30.197-11.736v31.046l5.718,2.223 c2.58,1.008,4.483,3.25,5.048,5.953c0.565,2.712-0.263,5.538-2.223,7.497L279.14,426.609c-3.834,3.824-9.561,5.03-14.62,3.071 l-43.064-16.748v31.046l30.226,11.755c17.18,6.678,36.678,2.581,49.715-10.454l202.594-202.59 C510.519,236.161,513.317,226.77,511.414,217.728z"/>
				<path d="M30.914,299.684c1.356-18.895,7.423-43.649,28.466-42.481l192.2,74.751 c17.228,6.698,36.782,2.553,49.818-10.558l185.771-186.991c6.5-6.538,9.269-15.919,7.357-24.933 c-1.912-9.023-8.242-16.474-16.832-19.809L286.666,15.374c-17.228-6.698-36.791-2.553-49.818,10.559L21.646,242.538 C4.625,256.545,0,282.664,0,305.863c0,23.2,1.545,51.043,27.844,61.866l-6.198-1.451l57.942,22.532v-20.742 c0-3.372,0.42-6.668,1.107-9.88l-38.94-15.147C29.37,338.35,29.36,321.499,30.914,299.684z"/>
				<path d="M111.048,352.658c-4.088,4.107-6.381,9.645-6.381,15.41v96.076l40.823-8.741l50.888,44.383v-96.048 c0-5.793,2.298-11.331,6.386-15.419l16.272-16.276l-91.706-35.662L111.048,352.658z"/>
			</svg>
			<h3 class="text-lg font-semibold text-theme-on-surface mb-2 select-none">词库功能开发中</h3>
			<p class="text-sm text-theme-on-surface-variant select-none">此功能将允许您管理翻译词汇表和术语库</p>
		</div>
	</div>
</div>