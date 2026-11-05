<script lang="ts">
  import { tick } from 'svelte';
  import { assistanceText, type AssistanceService } from '../runtime/assistance';
  import type { PluginManager } from '../runtime/plugins';
  import type { Workbench } from '../runtime/workbench';
  import { message } from '../runtime/workbench';
  import type { Marker } from '../generated/core';
  import { rebaseTextChange, textChange, type TextChange } from '../runtime/text-rebase';
  import './assistance-panel.css';
  let {
    workbench,
    plugins,
    assistance,
  }: { workbench: Workbench; plugins: PluginManager; assistance: AssistanceService } = $props();
  const project = $derived($workbench.projects.find((p) => p.id === $workbench.activeId));
  const image = $derived(project?.images.find((i) => i.id === $workbench.imageId));
  const marker = $derived(image?.markers.find((m) => m.id === $workbench.markerId));
  const markerNumber = $derived(marker && image ? image.markers.indexOf(marker) + 1 : null);
  const ocrProviders = $derived($plugins.providers.filter((p) => p.kind === 'ocr'));
  const translators = $derived($plugins.providers.filter((p) => p.kind === 'translation'));
  let ocr = $state(''),
    translator = $state(''),
    wholePage = $state(false);
  let original = $state('');
  let originalScope = $state(''),
    originalDirty = $state(false);
  interface OriginalInput {
    scope: string;
    projectId: string;
    imageId: string;
    marker: Marker;
    local: string;
    changes: { before: string; change: TextChange }[];
    running: boolean;
    done: Promise<void>;
  }
  let input: OriginalInput | undefined,
    originalComposing = false,
    compositionPending = false;
  let originalElement = $state<HTMLTextAreaElement>();
  let selectionVersion = 0;
  const intercepting = $derived(
    $plugins.plugins.some(
      (plugin) =>
        plugin.enabled &&
        plugin.hooksState !== 'paused' &&
        !!plugin.manifest.contributes.beforeCommitHooks?.length,
    ),
  );
  $effect(() => {
    const scope = `${project?.id}/${image?.id}/${marker?.id}`;
    const cached = assistanceText(marker, 'originalText');
    if (scope !== originalScope) {
      originalScope = scope;
      original = cached;
      originalDirty = false;
      input =
        project && image && marker
          ? {
              scope,
              projectId: project.id,
              imageId: image.id,
              marker: JSON.parse(JSON.stringify(marker)),
              local: cached,
              changes: [],
              running: false,
              done: Promise.resolve(),
            }
          : undefined;
      originalComposing = false;
      compositionPending = false;
    } else if (!originalDirty) {
      original = cached;
      if (input && !input.running && !input.changes.length) input.local = cached;
    }
  });
  const busy = $derived(
    $assistance.some((run) => run.state === 'running' || run.state === 'committing'),
  );
  const latest = $derived($assistance.at(-1));
  const providerProgress = $derived(
    [...$plugins.tasks]
      .reverse()
      .find((task) => task.state === 'running' && task.kind === latest?.kind)?.progress,
  );
  const phaseMessage = $derived(
    providerProgress &&
      typeof providerProgress === 'object' &&
      !Array.isArray(providerProgress) &&
      typeof providerProgress.message === 'string'
      ? providerProgress.message
      : '',
  );
  const run = (operation: () => Promise<unknown>) =>
    void operation().catch((error) => workbench.notice(message(error)));
  const committedOriginal = (state: OriginalInput) =>
    assistanceText(
      workbench.value.projects
        .find((project) => project.id === state.projectId)
        ?.images.find((image) => image.id === state.imageId)
        ?.markers.find((marker) => marker.id === state.marker.id),
      'originalText',
    );
  function retainOriginal(state: OriginalInput, text: string) {
    workbench.retainOriginalDraft(state.projectId, state.imageId, state.marker, text);
  }
  function alignOriginal(state: OriginalInput, text: string) {
    if (state.scope !== originalScope) return;
    const element = originalElement,
      focused = !!element && element.ownerDocument.activeElement === element,
      before = original,
      anchor = focused
        ? rebaseTextChange(before, text, {
            from: element.selectionStart,
            to: element.selectionStart,
            insert: '',
          })?.change.from
        : undefined,
      head = focused
        ? rebaseTextChange(before, text, {
            from: element.selectionEnd,
            to: element.selectionEnd,
            insert: '',
          })?.change.from
        : undefined,
      version = ++selectionVersion;
    original = text;
    if (focused && anchor !== undefined && head !== undefined)
      void tick().then(() => {
        if (
          version === selectionVersion &&
          state.scope === originalScope &&
          original === text &&
          element.ownerDocument.activeElement === element
        )
          element.setSelectionRange(anchor, head);
      });
  }
  async function settleOriginalComposition() {
    while (originalComposing) await new Promise((resolve) => setTimeout(resolve, 16));
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    if (compositionPending) {
      compositionPending = false;
      if (input && original !== input.local) queueOriginal(input, original);
    }
  }
  function queueOriginal(state: OriginalInput, text: string): Promise<void> {
    if (state.local !== text) {
      state.changes.push({ before: state.local, change: textChange(state.local, text) });
      state.local = text;
    }
    if (state.running || !state.changes.length) return state.done;
    state.running = true;
    state.done = (async () => {
      let canonical = committedOriginal(state);
      while (state.changes.length) {
        const changes = state.changes.splice(0);
        let proposal = canonical,
          failed = false;
        for (const pending of changes) {
          const replay = rebaseTextChange(pending.before, proposal, pending.change);
          if (!replay) {
            failed = true;
            break;
          }
          proposal = replay.text;
        }
        if (failed) {
          retainOriginal(state, state.local);
          state.changes = [];
          if (state.scope === originalScope) {
            alignOriginal(state, canonical);
            originalDirty = false;
          }
          state.local = canonical;
          break;
        }
        // New input is expressed relative to the value displayed here, while
        // this proposal waits for its actual acknowledgement.
        state.local = proposal;
        if (state.scope === originalScope && !originalComposing) alignOriginal(state, proposal);
        try {
          canonical = await assistance.editOriginal(
            state.projectId,
            state.imageId,
            state.marker.id,
            proposal,
          );
        } catch (error) {
          const latest = state.scope === originalScope ? original : state.local;
          retainOriginal(state, latest);
          canonical = committedOriginal(state);
          workbench.notice(message(error));
        }
        if (state.scope === originalScope && (originalComposing || compositionPending))
          await settleOriginalComposition();
        if (!state.changes.length) {
          state.local = canonical;
          if (state.scope === originalScope) {
            alignOriginal(state, canonical);
            originalDirty = false;
          }
        }
      }
    })().finally(() => {
      state.running = false;
    });
    return state.done;
  }
  export async function barrier() {
    if (originalComposing || compositionPending) await settleOriginalComposition();
    while (input?.running) await input.done;
  }
  async function saveOriginal() {
    if (intercepting) {
      if (originalComposing || compositionPending) return;
      if (input) await queueOriginal(input, original);
      return;
    }
    if (project && image && marker) {
      const scope = originalScope,
        text = original;
      originalDirty = true;
      await assistance.editOriginal(project.id, image.id, marker.id, text);
      if (scope === originalScope && text === original) originalDirty = false;
    }
  }
</script>

<section class="assistance-section assistance-workspace" aria-label="OCR 与机器翻译">
  <div class="assistance-heading">
    <div class="assistance-context">
      <strong>OCR 与机器翻译</strong>
      <span aria-label="当前标记">{markerNumber ? `标记 #${markerNumber}` : '未选择标记'}</span>
    </div>
    <label><input type="checkbox" bind:checked={wholePage} />整页标记</label>
  </div>
  <div class="assistance-columns">
    <div class="assistance-column">
      <div class="assistance-controls">
        <select aria-label="OCR 插件" bind:value={ocr} disabled={!ocrProviders.length}>
          <option value="">{ocrProviders.length ? '选择 OCR 插件' : '尚未安装 OCR 插件'}</option>
          {#each ocrProviders as provider}<option value={provider.id}>{provider.info.name}</option
            >{/each}
        </select>
        <button
          disabled={!ocr || busy || !(wholePage ? image?.markers.length : marker)}
          onclick={() => run(() => assistance.run('ocr', ocr, wholePage))}>识别原文</button
        >
      </div>
      {#if marker}
        <label class="assistance-label"
          >原文<textarea
            aria-label="OCR 原文"
            data-assistance-editor
            bind:this={originalElement}
            rows="3"
            bind:value={original}
            oninput={(event) => {
              original = event.currentTarget.value;
              originalDirty = true;
              run(saveOriginal);
            }}
            oncompositionstart={() => {
              if (intercepting) {
                originalComposing = true;
                compositionPending = true;
              }
            }}
            oncompositionend={() => {
              originalComposing = false;
              if (compositionPending) void settleOriginalComposition();
            }}></textarea></label
        >
      {:else}
        <div class="assistance-empty">选择一个标记，查看和编辑识别原文</div>
      {/if}
    </div>
    <div class="assistance-column">
      <div class="assistance-controls">
        <select aria-label="翻译插件" bind:value={translator} disabled={!translators.length}>
          <option value="">{translators.length ? '选择翻译插件' : '尚未安装翻译插件'}</option>
          {#each translators as provider}<option value={provider.id}>{provider.info.name}</option
            >{/each}
        </select>
        <button
          disabled={!translator ||
            busy ||
            !(wholePage ? image?.markers.length : marker && original.trim())}
          onclick={() =>
            run(async () => {
              await saveOriginal();
              await barrier();
              await assistance.run('translation', translator, wholePage);
            })}>机器翻译</button
        >
      </div>
      {#if marker}
        <label class="assistance-label"
          >机器译文<textarea
            aria-label="机器译文"
            readonly
            rows="3"
            value={assistanceText(marker, 'machineTranslation')}></textarea></label
        >
        <button
          class="assistance-adopt"
          disabled={!assistanceText(marker, 'machineTranslation')}
          onclick={() => run(() => assistance.adopt(project!.id, image!.id, marker!))}
          >采用机器译文</button
        >
      {:else}
        <div class="assistance-empty">选择一个标记，查看和采用机器译文</div>
      {/if}
    </div>
  </div>
  {#if latest}
    <div class="assistance-progress" role="status">
      <div class="assistance-progress-text">
        {#if phaseMessage}<small aria-label="推理阶段">{phaseMessage}</small>{/if}
        <span
          >{latest.kind === 'ocr' ? '识别' : '翻译'}
          {latest.done}/{latest.total} · {latest.state === 'running'
            ? '处理中'
            : latest.state === 'committing'
              ? '正在保存结果'
              : latest.state === 'cancelled'
                ? '已取消'
                : latest.state === 'failed'
                  ? '失败'
                  : `已写入 ${latest.applied} 项`}</span
        >
      </div>
      {#if (latest.state === 'running' || latest.state === 'committing') && latest.cancellable !== false}<button
          onclick={() => assistance.cancel(latest.id)}>取消任务</button
        >{/if}
    </div>
  {/if}
</section>
