<script lang="ts">
	import { modalStore } from '$lib/services/modalService';
	import { projectService } from '$lib/services/projectService';
	import AboutModal from './AboutModal.svelte';
	import LicenseModal from './LicenseModal.svelte';
	import ConfirmModal from './ConfirmModal.svelte';
	import NewProjectModal from './NewProjectModal.svelte';
	import OpenProjectModal from './OpenProjectModal.svelte';
	import SnapshotModal from './SnapshotModal.svelte';
	import SettingsModal from './SettingsModal.svelte';

	async function handleNewProjectSuccess(detail: { projectId: number; projectName: string; imageCount: number }) {
		const { projectId, projectName, imageCount } = detail;
		console.log(`✅ 项目创建成功: ${projectName}, 图片数量: ${imageCount}`);
		// 刷新项目列表
		await projectService.loadProjects();
		// 设置为当前项目
		projectService.setCurrentProject(projectId);
		modalStore.hideModal();
	}

	async function handleOpenProjectSuccess(detail: { projectId: number; projectName: string; imageCount: number }) {
		const { projectId, projectName, imageCount } = detail;
		console.log(`✅ 项目导入成功: ${projectName}, 图片数量: ${imageCount}`);
		// 刷新项目列表
		await projectService.loadProjects();
		// 设置为当前项目
		projectService.setCurrentProject(projectId);
		modalStore.hideModal();
	}
</script>

<!-- 全局Modal管理 -->
{#if $modalStore.activeModal === 'about'}
	<AboutModal visible={true} onClose={() => modalStore.hideModal()} />
{:else if $modalStore.activeModal === 'license'}
	<LicenseModal visible={true} onClose={() => modalStore.hideModal()} />
{:else if $modalStore.activeModal === 'newProject'}
	<NewProjectModal
		visible={true}
		defaultName={$modalStore.modalData.defaultName || ''}
		onSuccess={handleNewProjectSuccess}
		onCancel={() => modalStore.hideModal()}
	/>
{:else if $modalStore.activeModal === 'openProject'}
	<OpenProjectModal
		visible={true}
		initialFilePath={$modalStore.modalData.initialFilePath}
		autoProcess={$modalStore.modalData.autoProcess}
		onSuccess={handleOpenProjectSuccess}
		onCancel={() => modalStore.hideModal()}
	/>
{:else if $modalStore.activeModal === 'confirm'}
	<ConfirmModal
		visible={true}
		title={$modalStore.modalData.title || '确认'}
		message={$modalStore.modalData.message || ''}
		confirmText={$modalStore.modalData.confirmText || '确认'}
		cancelText={$modalStore.modalData.cancelText || '取消'}
		onConfirm={() => {
			$modalStore.modalData.onConfirm?.(null);
			modalStore.hideModal();
		}}
		onCancel={() => {
			$modalStore.modalData.onCancel?.();
			modalStore.hideModal();
		}}
	/>
{:else if $modalStore.activeModal === 'snapshot'}
	<SnapshotModal onClose={() => modalStore.hideModal()} />
{:else if $modalStore.activeModal === 'settings'}
	<SettingsModal visible={true} onClose={() => modalStore.hideModal()} />
{/if}