<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import type { Workbench, ProjectView } from '../runtime/workbench';
  import { message } from '../runtime/workbench';
  import { collectSearchFields, type SearchMatch, type SearchOptions } from '../runtime/search';
  import { SearchService } from '../runtime/search-client';

  let {
    project,
    workbench,
    open,
    width,
    onselect,
    onhighlight,
  }: {
    project?: ProjectView;
    workbench: Workbench;
    open: boolean;
    width: number;
    onselect(match: SearchMatch, isCurrent: () => boolean): Promise<void>;
    onhighlight(match: SearchMatch | null): void;
  } = $props();
  const search = new SearchService(),
    replacementSearch = new SearchService();
  let options = $state<SearchOptions>({
    query: '',
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    includeOriginal: false,
    includeMachine: false,
  });
  let replacement = $state(''),
    matches = $state.raw<SearchMatch[]>([]);
  let selected = $state(-1),
    start = $state(0),
    shown = $state(100),
    searching = $state(false),
    replacing = $state(false);
  let error = $state(''),
    operationError = $state(''),
    feedback = $state(''),
    revision = $state(0);
  let queryElement: HTMLInputElement;
  let generation = 0;
  let inputIdentity = '';
  let pendingNext: { previous: SearchMatch; from: number } | undefined;
  const current = $derived(matches[selected]);
  const scope = $derived(project ? `${project.id}/${project.stateId}` : '');
  const ready = $derived(!!project && !searching && !replacing && !error && matches.length > 0);
  const labels = { translation: '译文', originalText: 'OCR 原文', machineTranslation: '机器译文' };
  const groups = $derived.by(() => {
    const result: { imageId: string; filename: string; page: number; matches: SearchMatch[] }[] =
      [];
    for (const match of matches.slice(start, shown)) {
      let group = result.at(-1);
      if (!group || group.imageId !== match.imageId) {
        group = { imageId: match.imageId, filename: match.filename, page: match.page, matches: [] };
        result.push(group);
      }
      group.matches.push(match);
    }
    return result;
  });
  export function focus() {
    queryElement?.focus();
    queryElement?.select();
  }
  const sameField = (a: SearchMatch, b: SearchMatch) =>
    a.imageId === b.imageId && a.markerId === b.markerId && a.field === b.field;
  async function choose(match: SearchMatch) {
    const index = matches.indexOf(match);
    if (index < 0 || !ready || !open) return;
    selected = index;
    const token = generation;
    if (index < start || index >= shown) {
      start = Math.floor(index / 100) * 100;
      shown = start + 100;
    }
    try {
      await onselect(match, () => open && token === generation && current?.key === match.key);
      if (!open || token !== generation || current?.key !== match.key) return;
      await tick();
      queryElement
        ?.closest('[data-search-panel]')
        ?.querySelector('[aria-pressed="true"]')
        ?.scrollIntoView({ block: 'nearest' });
    } catch (reason) {
      if (token === generation) operationError = message(reason);
    }
  }
  function navigate(delta: number) {
    if (!ready) return;
    const index =
      selected < 0
        ? delta < 0
          ? matches.length - 1
          : 0
        : (selected + delta + matches.length) % matches.length;
    void choose(matches[index]);
  }
  function snippet(match: SearchMatch) {
    const from = Math.max(0, match.from - 26),
      to = Math.min(match.text.length, match.to + 40);
    return {
      before: `${from ? '…' : ''}${match.text.slice(from, match.from)}`,
      hit: match.text.slice(match.from, match.to),
      after: `${match.text.slice(match.to, to)}${to < match.text.length ? '…' : ''}`,
    };
  }
  $effect(() => {
    scope;
    const snapshot = untrack(() => project),
      stateId = snapshot?.stateId;
    const captured = { ...options };
    const identity = JSON.stringify([snapshot?.id, captured]);
    if (identity !== inputIdentity) {
      inputIdentity = identity;
      untrack(() => {
        feedback = '';
        operationError = '';
        pendingNext = undefined;
      });
    }
    revision;
    const token = ++generation;
    search.cancel();
    untrack(() => {
      matches = [];
      selected = -1;
      start = 0;
      shown = 100;
      error = '';
      searching = !!snapshot && !!captured.query;
    });
    if (!snapshot || !captured.query) return;
    const timer = setTimeout(() => {
      void search
        .search(collectSearchFields(snapshot), captured)
        .then(async (found) => {
          if (token !== generation || project?.id !== snapshot.id || project?.stateId !== stateId)
            return;
          matches = found;
          searching = false;
          const next = pendingNext;
          pendingNext = undefined;
          if (next && next.previous.projectId === snapshot.id && found.length) {
            const inField = found.findIndex(
              (item) => sameField(item, next.previous) && item.from >= next.from,
            );
            const laterField = found.findIndex(
              (item) =>
                item.page > next.previous.page ||
                (item.page === next.previous.page &&
                  item.markerNumber > next.previous.markerNumber) ||
                (item.page === next.previous.page &&
                  item.markerNumber === next.previous.markerNumber &&
                  Object.keys(labels).indexOf(item.field) >
                    Object.keys(labels).indexOf(next.previous.field)),
            );
            const index = inField >= 0 ? inField : laterField >= 0 ? laterField : 0;
            await tick();
            if (token === generation) await choose(found[index]);
          }
        })
        .catch((reason) => {
          if (token !== generation) return;
          error = message(reason);
          searching = false;
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      search.cancel();
    };
  });
  $effect(() => {
    onhighlight(open ? (current ?? null) : null);
  });
  async function replace(all: boolean) {
    if (!ready || (!all && !current)) return;
    const target = all ? undefined : current;
    const captured = { ...options },
      projectId = project!.id;
    replacing = true;
    feedback = '';
    operationError = '';
    try {
      const result = await workbench.replaceSearch(
        replacementSearch,
        captured,
        replacement,
        target,
      );
      if (project?.id !== projectId) return;
      feedback = `已替换 ${result.matchCount} 处`;
      if (target && JSON.stringify(options) === JSON.stringify(captured)) {
        const edit = result.changes.find(
          (item) =>
            item.imageId === target.imageId &&
            item.markerId === target.markerId &&
            item.field === target.field,
        )?.edits[0];
        pendingNext = {
          previous: target,
          from: edit
            ? edit.from + edit.insert.length + (edit.from === edit.to ? 1 : 0)
            : target.to + (target.from === target.to ? 1 : 0),
        };
      }
    } catch (reason) {
      operationError = message(reason);
    } finally {
      replacing = false;
      revision++;
    }
  }
  onDestroy(() => {
    search.dispose();
    replacementSearch.dispose();
  });
</script>

<aside
  class="search-sidebar"
  class:left-panel={open}
  aria-label="查找替换"
  data-search-panel
  style:width={`${width}px`}
  style:display={open ? 'flex' : 'none'}
>
  <div class="panel-heading"><strong>查找替换</strong><Icon name="search" size={17} /></div>
  <div class="search-controls">
    <input
      bind:this={queryElement}
      aria-label="查找文本"
      placeholder="在当前项目中查找"
      bind:value={options.query}
      spellcheck="false"
      onkeydown={(event) => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          navigate(event.shiftKey ? -1 : 1);
        }
      }}
    />
    <div class="search-options" aria-label="匹配规则">
      <label title="区分大小写"
        ><input type="checkbox" bind:checked={options.caseSensitive} />区分大小写</label
      >
      <label title="按 Unicode 词边界匹配，不进行中日韩分词"
        ><input type="checkbox" bind:checked={options.wholeWord} />整词</label
      >
      <label title="JavaScript Unicode 多行正则"
        ><input type="checkbox" bind:checked={options.regex} />正则</label
      >
    </div>
    <textarea
      aria-label="替换文本"
      placeholder="替换为（支持换行）"
      rows="2"
      bind:value={replacement}
      spellcheck="false"></textarea>
    {#if options.regex}<small class="muted">捕获组：$1、$&lt;名称&gt;；使用 $$ 输入 $</small>{/if}
    <div class="search-scopes">
      <label><input type="checkbox" bind:checked={options.includeOriginal} />包含 OCR 原文</label>
      <label><input type="checkbox" bind:checked={options.includeMachine} />包含机器译文</label>
    </div>
    <div class="search-actions">
      <button disabled={!ready || !current} onclick={() => void replace(false)}>替换当前项</button>
      <button disabled={!ready} onclick={() => void replace(true)}>全部替换</button>
    </div>
    <div class="search-status" role="status" aria-live="polite">
      <span data-testid="search-count"
        >{!project
          ? '请先打开项目'
          : searching
            ? '正在查找…'
            : replacing
              ? '正在替换…'
              : `${matches.length} 处匹配${selected >= 0 ? ` · ${selected + 1}/${matches.length}` : ''}`}</span
      >
      <div>
        <button
          class="icon-button"
          aria-label="上一个匹配"
          title="上一个匹配 (Shift+Enter)"
          disabled={!ready}
          onclick={() => navigate(-1)}>↑</button
        >
        <button
          class="icon-button"
          aria-label="下一个匹配"
          title="下一个匹配 (Enter)"
          disabled={!ready}
          onclick={() => navigate(1)}>↓</button
        >
      </div>
    </div>
    {#if error}<p class="search-error" role="alert">{error}</p>{/if}
    {#if operationError}<p class="search-error" role="alert">{operationError}</p>{/if}
    {#if feedback}<p class="search-feedback" role="status">{feedback}</p>{/if}
  </div>
  <div class="search-results">
    {#if start > 0}<button
        class="search-more"
        onclick={() => {
          start = Math.max(0, start - 100);
          shown = start + 100;
        }}>显示前一批结果</button
      >{/if}
    {#each groups as group (group.imageId)}
      <section aria-label={`第 ${group.page} 页 ${group.filename}`}>
        <h3 title={group.filename}>{group.page}. {group.filename}</h3>
        {#each group.matches as match (match.key)}
          {@const context = snippet(match)}
          <button
            class="search-result"
            class:chosen={current?.key === match.key}
            aria-label={`第 ${match.page} 页 标记 ${match.markerNumber} ${labels[match.field]} 匹配 ${match.index + 1}`}
            aria-pressed={current?.key === match.key}
            onclick={() => void choose(match)}
          >
            <span class="search-result-meta"
              >#{match.markerNumber}<span>{labels[match.field]}</span></span
            >
            <span class="search-snippet"
              >{context.before}<mark class:zero-width={match.from === match.to}
                >{context.hit || '│'}</mark
              >{context.after}</span
            >
          </button>
        {/each}
      </section>
    {/each}
    {#if matches.length > shown}<button class="search-more" onclick={() => (shown += 100)}
        >继续显示（剩余 {matches.length - shown} 处）</button
      >{/if}
  </div>
</aside>

<style>
  .search-sidebar {
    flex-direction: column;
    min-width: 180px;
    overflow: hidden;
  }
  .search-controls {
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    border-bottom: 1px solid var(--line);
  }
  input:not([type='checkbox']),
  textarea {
    width: 100%;
    min-width: 0;
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 8px;
    color: var(--text);
    background: var(--surface);
  }
  textarea {
    resize: vertical;
    min-height: 54px;
    max-height: 180px;
  }
  input:focus,
  textarea:focus {
    outline: 1px solid var(--accent);
  }
  .search-options,
  .search-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
  }
  input[type='checkbox'] {
    margin: 0;
    accent-color: var(--accent);
  }
  .search-scopes {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .search-actions button,
  .search-more {
    border: 1px solid var(--line);
    background: var(--surface);
    padding: 6px 8px;
    font-size: 12px;
  }
  .search-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
    gap: 4px;
  }
  .search-status > div {
    display: flex;
  }
  .search-results {
    overflow: auto;
    flex: 1;
    min-height: 0;
    padding-bottom: 12px;
  }
  h3 {
    font-size: 12px;
    margin: 0;
    padding: 10px 12px 6px;
    color: var(--strong);
    background: var(--surface2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .search-result {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 5px;
    width: 100%;
    padding: 8px 12px;
    text-align: left;
    border-radius: 0;
    border-left: 2px solid transparent;
  }
  .search-result:hover {
    background: var(--surface3);
  }
  .search-result.chosen {
    background: var(--accent-soft);
    border-left-color: var(--accent);
  }
  .search-result-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 11px;
  }
  .search-snippet {
    font-size: 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.7;
  }
  mark {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
    color: var(--strong);
    border-radius: 2px;
  }
  .zero-width {
    color: var(--accent-deep);
    font-weight: bold;
  }
  .search-more {
    margin: 10px 12px;
  }
  .search-error {
    margin: 0;
    color: var(--danger);
    overflow-wrap: anywhere;
    font-size: 12px;
  }
  .search-feedback {
    margin: 0;
    color: var(--accent-deep);
    font-size: 12px;
  }
</style>
