<script lang="ts">
  import Icon from './Icon.svelte';
  import Thumbnail from './Thumbnail.svelte';
  import type { ProjectDocument } from '../generated/core';
  import type { AssetStore } from '../runtime/assets';
  import type { ProjectView } from '../runtime/workbench';

  type ProjectChange = Partial<Pick<ProjectDocument, 'name' | 'sourceLanguage' | 'targetLanguage'>>;
  let {
    project,
    assets,
    selectedImageId,
    mode,
    width,
    onselect,
    onadd,
    onremove,
    onreorder,
    onsort,
    onprojectchange,
  }: {
    project?: ProjectView;
    assets: AssetStore;
    selectedImageId: string | null;
    mode: 'images' | 'settings';
    width: number;
    onselect: (id: string) => void;
    onadd: () => void;
    onremove: (id: string) => void;
    onreorder: (from: string, to: string) => void;
    onsort: () => void;
    onprojectchange: (patch: ProjectChange, label: string) => void;
  } = $props();

  let dragImage = $state<string | null>(null);
  const languages = [
    ['japanese', '日语'],
    ['english', '英语'],
    ['simplifiedChinese', '简体中文'],
    ['traditionalChinese', '繁体中文'],
  ];

  function rename(event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (!project || event.isComposing) return;
    if (event.key === 'Enter') {
      onprojectchange({ name: event.currentTarget.value }, '修改项目名称');
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      event.currentTarget.value = project.name;
      event.currentTarget.blur();
    }
  }
</script>

<aside class="left-panel" style:width={`${width}px`}>
  <div class="panel-heading">
    <span>{mode === 'images' ? '图片' : '项目配置'}</span>
    <span class="muted count">{project?.images.length ?? 0}</span>
    <div class="grow"></div>
    <button
      class="icon-button"
      title="添加图片"
      aria-label="添加图片"
      disabled={!project}
      onclick={onadd}><Icon name="plus" size={16} /></button
    >
  </div>
  {#if mode === 'settings' && project}
    <div class="project-settings">
      <label>
        项目名称<input
          aria-label="修改项目名称"
          value={project.name}
          onkeydown={rename}
          onblur={(event) => {
            if (project) event.currentTarget.value = project.name;
          }}
        />
      </label>
      <label>
        原文语言<select
          aria-label="原文语言"
          value={project.sourceLanguage}
          onchange={(event) =>
            onprojectchange({ sourceLanguage: event.currentTarget.value }, '修改原文语言')}
          >{#each languages as [value, label]}<option {value}>{label}</option>{/each}</select
        >
      </label>
      <label>
        译文语言<select
          aria-label="译文语言"
          value={project.targetLanguage}
          onchange={(event) =>
            onprojectchange({ targetLanguage: event.currentTarget.value }, '修改译文语言')}
          >{#each languages as [value, label]}<option {value}>{label}</option>{/each}</select
        >
      </label>
      <hr />
      <div class="section-label">图片管理</div>
      <button class="subtle-button" onclick={onsort}
        ><Icon name="sort" size={15} />按文件名自然排序</button
      >
    </div>
  {/if}
  <div class="image-list">
    {#each project?.images ?? [] as item, index (item.id)}
      <div
        class="image-row"
        role="group"
        aria-label={`图片管理 ${index + 1}`}
        class:current={item.id === selectedImageId}
        draggable={mode === 'settings'}
        ondragstart={() => (dragImage = item.id)}
        ondragend={() => (dragImage = null)}
        ondragover={(event) => event.preventDefault()}
        ondrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (dragImage) onreorder(dragImage, item.id);
          dragImage = null;
        }}
      >
        <button
          class="image-select"
          aria-label={`图片 ${index + 1} ${item.filename}`}
          onclick={() => onselect(item.id)}
        >
          <Thumbnail assetId={item.assetId} {assets} alt={item.filename} />
          <span class="image-info">
            <span>{item.filename}</span>
            <small>{item.width} × {item.height} · {item.markers.length} 个标记</small>
          </span>
          <span class="page-index">{index + 1}</span>
        </button>
        {#if mode === 'settings'}
          <button
            class="delete-image"
            title="删除图片"
            aria-label={`删除图片 ${index + 1}`}
            onclick={() => onremove(item.id)}><Icon name="trash" size={14} /></button
          >
        {/if}
      </div>
    {:else}
      <div class="panel-empty">
        <Icon name="images" size={28} />
        <p>还没有图片</p>
        <small>{project ? '添加漫画页以开始标注' : '新建或打开一个项目'}</small>
      </div>
    {/each}
  </div>
  {#if project}
    <button class="add-images-button" onclick={onadd}><Icon name="plus" size={16} />添加图片</button
    >
  {/if}
</aside>
