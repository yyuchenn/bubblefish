<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Schema, type Node as PMNode } from 'prosemirror-model';
  import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
  import { EditorView } from 'prosemirror-view';
  import { keymap } from 'prosemirror-keymap';
  import {
    baseKeymap,
    toggleMark,
    selectTextblockStart,
    selectTextblockEnd,
  } from 'prosemirror-commands';
  import { Mapping, StepMap, type Step } from 'prosemirror-transform';
  import type {
    EditorBookmark,
    HistoryMeta,
    Marker,
    RichText,
    TextMark,
    TextRun,
  } from '../generated/core';
  import type { ViewState } from '../runtime/workbench';

  let {
    marker,
    imageId,
    restore,
    onchange,
    onboundary,
    onaction,
    autofocus = true,
    onrecover,
  }: {
    marker: Marker;
    imageId: string;
    restore: ViewState['editorRestore'];
    onchange: (value: RichText, history: HistoryMeta) => void;
    onboundary: () => void;
    onaction: (name: string) => void;
    autofocus?: boolean;
    onrecover: (draft: { imageId: string; marker: Marker }) => void;
  } = $props();
  let element: HTMLDivElement;
  let view = $state.raw<EditorView>();
  let composing = false,
    disposed = false,
    restoredVersion = -1;
  let group = '',
    previousKind = '',
    previousEnd = -1,
    previousTime = 0;
  let compositionGroup: string | undefined,
    inputType = '';
  let active = $state<TextMark[]>([]);
  let transition = false,
    bufferedSteps: Step[] = [],
    bufferedSelection: EditorBookmark | undefined;
  let bufferedBatches: { before: PMNode; steps: Step[]; selection: EditorBookmark }[] = [];
  let transitionDone: Promise<void> = Promise.resolve();
  let pendingDraft: RichText | undefined;
  const marks: TextMark[] = ['bold', 'italic', 'strike', 'emphasis'];
  const schema = new Schema({
    nodes: {
      doc: { content: 'paragraph+' },
      paragraph: {
        content: 'text*',
        group: 'block',
        parseDOM: [{ tag: 'p' }],
        toDOM: () => ['p', 0],
      },
      text: { group: 'inline' },
    },
    marks: {
      bold: {
        parseDOM: [{ tag: 'strong' }, { tag: 'b' }, { style: 'font-weight=bold' }],
        toDOM: () => ['strong', 0],
      },
      italic: { parseDOM: [{ tag: 'i' }, { tag: 'em' }], toDOM: () => ['em', 0] },
      strike: { parseDOM: [{ tag: 's' }, { tag: 'del' }], toDOM: () => ['s', 0] },
      emphasis: {
        parseDOM: [{ tag: 'span[data-emphasis]' }],
        toDOM: () => ['span', { 'data-emphasis': 'true', class: 'emphasis' }, 0],
      },
    },
  });
  function toDoc(value: RichText): PMNode {
    const paragraphs: PMNode[] = [];
    let content: PMNode[] = [];
    for (const run of value.runs) {
      const parts = run.text.split('\n');
      parts.forEach((part, index) => {
        if (index) {
          paragraphs.push(schema.node('paragraph', null, content));
          content = [];
        }
        if (part)
          content.push(
            schema.text(
              part,
              run.marks.map((mark) => schema.mark(mark)),
            ),
          );
      });
    }
    paragraphs.push(schema.node('paragraph', null, content));
    return schema.node('doc', null, paragraphs);
  }
  function fromDoc(doc: PMNode): RichText {
    const runs: TextRun[] = [];
    const append = (text: string, runMarks: TextMark[]) => {
      if (!text) return;
      const last = runs.at(-1);
      if (last && last.marks.join() === runMarks.join()) last.text += text;
      else runs.push({ text, marks: runMarks });
    };
    doc.forEach((paragraph, _offset, index) => {
      if (index) append('\n', []);
      paragraph.forEach((node) =>
        append(
          node.text ?? '',
          marks.filter((mark) => node.marks.some((m) => m.type.name === mark)),
        ),
      );
    });
    return { runs };
  }
  function bookmark(state: EditorState): EditorBookmark {
    return {
      imageId,
      markerId: marker.id,
      anchor: state.selection.anchor,
      head: state.selection.head,
      storedMarks: (state.storedMarks ?? state.selection.$from.marks()).map(
        (mark) => mark.type.name as TextMark,
      ),
    };
  }
  function syncDOMSelection(editor: EditorView) {
    if (composing || editor.composing) return;
    const selection = editor.dom.ownerDocument.getSelection();
    if (
      !selection?.anchorNode ||
      !selection.focusNode ||
      !editor.dom.contains(selection.anchorNode) ||
      !editor.dom.contains(selection.focusNode)
    )
      return;
    try {
      const anchor = editor.posAtDOM(selection.anchorNode, selection.anchorOffset),
        head = editor.posAtDOM(selection.focusNode, selection.focusOffset);
      if (anchor !== editor.state.selection.anchor || head !== editor.state.selection.head)
        editor.dispatch(
          editor.state.tr.setSelection(TextSelection.create(editor.state.doc, anchor, head)),
        );
    } catch {
      /* A composition or DOM mutation may still be settling; ProseMirror owns its recovery. */
    }
  }
  function endGroup() {
    group = '';
    previousKind = '';
    previousEnd = -1;
    if (!composing && !view?.composing) compositionGroup = undefined;
    onboundary();
  }
  function apply(transaction: Transaction) {
    if (!view) return;
    const before = view.state;
    const result = before.applyTransaction(transaction);
    view.updateState(result.state);
    active = bookmark(result.state).storedMarks;
    if (transition) {
      const steps = result.transactions.flatMap((tr) => tr.steps);
      bufferedSteps.push(...steps);
      bufferedSelection = bookmark(result.state);
      bufferedBatches.push({ before: before.doc, steps, selection: bookmark(result.state) });
      if (steps.length) pendingDraft = fromDoc(result.state.doc);
      return;
    }
    if (!result.transactions.some((tr) => tr.docChanged)) {
      if (!composing && !view.composing && (transaction.selectionSet || transaction.storedMarksSet))
        endGroup();
      return;
    }
    const now = performance.now();
    const composition = transaction.getMeta('composition');
    const event = transaction.getMeta('uiEvent') as string | undefined;
    const delta = result.state.doc.content.size - before.doc.content.size;
    const kind =
      event ??
      (delta > 0
        ? 'insert'
        : delta < 0
          ? `delete-${inputType.includes('Forward') ? 'forward' : 'backward'}`
          : 'replace');
    const boundary = event || kind === 'replace' || !before.selection.empty;
    if (composition != null || composing || view.composing) {
      compositionGroup ??= `ime-${crypto.randomUUID()}`;
      group = compositionGroup;
    } else if (
      !group ||
      group.startsWith('ime-') ||
      boundary ||
      kind !== previousKind ||
      previousEnd !== before.selection.head ||
      now - previousTime > 1000
    )
      group = crypto.randomUUID();
    onchange(fromDoc(result.state.doc), {
      label: '编辑翻译',
      groupId: group,
      before: bookmark(before),
      after: bookmark(result.state),
    });
    previousKind = kind;
    previousEnd = result.state.selection.head;
    previousTime = now;
    if ((event || kind === 'replace') && !composing && composition == null && !view.composing)
      group = '';
  }
  function format(mark: TextMark) {
    if (!view || composing) return;
    endGroup();
    toggleMark(schema.marks[mark])(view.state, (tr) => {
      tr.setMeta('uiEvent', 'format');
      apply(tr);
    });
    view.focus();
  }
  export async function barrier(allowTransition = false) {
    if (transition && !allowTransition) await transitionDone;
    if (!view || disposed) return;
    while (!disposed && (composing || view.composing))
      await new Promise((resolve) => setTimeout(resolve, 16));
    // The DOM compositionend event can precede ProseMirror's final transaction.
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    endGroup();
  }
  export function focus() {
    view?.focus();
  }
  /** Keep edits arriving while native/WASM Undo is in flight, then rebase them. */
  export async function exclusive(operation: () => Promise<unknown>) {
    if (transition) {
      await transitionDone;
      return exclusive(operation);
    }
    if (!view || disposed) return operation();
    transition = true;
    pendingDraft = undefined;
    bufferedSteps = [];
    bufferedBatches = [];
    bufferedSelection = undefined;
    const base = view.state.doc,
      initialSelection = bookmark(view.state);
    const originalMarker: Marker = JSON.parse(JSON.stringify(marker));
    const recover = onrecover,
      originalImageId = imageId;
    let draftValue: RichText | undefined;
    let finish!: () => void;
    transitionDone = new Promise((resolve) => (finish = resolve));
    try {
      await operation();
      await tick();
    } finally {
      try {
        draftValue = pendingDraft;
        if (disposed && bufferedSteps.length) {
          recover({
            imageId: originalImageId,
            marker: { ...originalMarker, translation: pendingDraft ?? originalMarker.translation },
          });
        }
        if (view && !disposed && bufferedSteps.length) {
          const canonical = toDoc(marker.translation);
          const restored =
            restore?.bookmark.markerId === marker.id ? restore.bookmark : initialSelection;
          view.updateState(
            EditorState.create({
              schema,
              doc: canonical,
              plugins: view.state.plugins,
              selection: TextSelection.create(
                canonical,
                Math.max(1, Math.min(canonical.content.size - 1, restored.anchor)),
                Math.max(1, Math.min(canonical.content.size - 1, restored.head)),
              ),
              storedMarks: restored.storedMarks.map((mark) => schema.mark(mark)),
            }),
          );
          const replay = view.state.tr;
          let failed = false;
          for (const batch of bufferedBatches) {
            const start = batch.before.content.findDiffStart(replay.doc.content),
              end = batch.before.content.findDiffEnd(replay.doc.content);
            const samePositions =
              batch.before.content.size === replay.doc.content.size &&
              batch.before.textBetween(0, batch.before.content.size, '\n') ===
                replay.doc.textBetween(0, replay.doc.content.size, '\n');
            let mapping = new Mapping(
              samePositions || start === null || !end
                ? []
                : [new StepMap([start, Math.max(0, end.a - start), Math.max(0, end.b - start)])],
            );
            for (const step of batch.steps) {
              const mapped = step.map(mapping);
              if (mapped) {
                const result = replay.maybeStep(mapped);
                if (result.failed) failed = true;
                mapping = new Mapping([
                  step.getMap().invert(),
                  ...mapping.maps,
                  ...(!result.failed ? [mapped.getMap()] : []),
                ]);
              } else {
                failed = true;
                mapping = new Mapping([step.getMap().invert(), ...mapping.maps]);
              }
            }
            const selection = batch.selection;
            const max = replay.doc.content.size - 1;
            replay.setSelection(
              TextSelection.create(
                replay.doc,
                Math.max(1, Math.min(max, mapping.map(selection.anchor))),
                Math.max(1, Math.min(max, mapping.map(selection.head))),
              ),
            );
            replay.setStoredMarks(selection.storedMarks.map((mark) => schema.mark(mark)));
          }
          transition = false;
          bufferedSteps = [];
          apply(replay.setMeta('uiEvent', 'bufferedInput'));
          if (failed && draftValue)
            recover({
              imageId: originalImageId,
              marker: { ...originalMarker, translation: draftValue },
            });
        }
      } finally {
        transition = false;
        bufferedSteps = [];
        bufferedBatches = [];
        bufferedSelection = undefined;
        pendingDraft = undefined;
        finish();
      }
    }
  }
  const workspaceKey = (name: string) => () => {
    if (composing || view?.composing) return false;
    onaction(name);
    return true;
  };
  onMount(() => {
    view = new EditorView(element, {
      state: EditorState.create({
        schema,
        doc: toDoc(marker.translation),
        plugins: [
          keymap({
            ...baseKeymap,
            'Mod-b': toggleMark(schema.marks.bold),
            'Mod-i': toggleMark(schema.marks.italic),
            'Mod-z': workspaceKey('app.undo'),
            'Mod-Shift-z': workspaceKey('app.redo'),
            'Mod-y': workspaceKey('app.redo'),
            'Mod-ArrowLeft': workspaceKey('app.previousImage'),
            'Mod-ArrowRight': workspaceKey('app.nextImage'),
            Tab: workspaceKey('app.nextMarker'),
            'Shift-Tab': workspaceKey('app.previousMarker'),
            Home: selectTextblockStart,
            End: selectTextblockEnd,
          }),
        ],
      }),
      dispatchTransaction: apply,
      attributes: {
        role: 'textbox',
        'aria-label': '翻译内容',
        'aria-multiline': 'true',
        spellcheck: 'false',
      },
      handleDOMEvents: {
        compositionstart: (editor) => {
          syncDOMSelection(editor);
          composing = true;
          compositionGroup = `ime-${crypto.randomUUID()}`;
          group = compositionGroup;
          return false;
        },
        compositionend: () => {
          composing = false;
          return false;
        },
        beforeinput: (editor, event) => {
          syncDOMSelection(editor);
          inputType = (event as InputEvent).inputType;
          return false;
        },
        paste: (editor) => {
          syncDOMSelection(editor);
          return false;
        },
        keydown: (_view, event) => {
          if (event.key === 'Backspace') inputType = 'deleteContentBackward';
          else if (event.key === 'Delete') inputType = 'deleteContentForward';
          return false;
        },
        blur: () => {
          if (!composing) endGroup();
          return false;
        },
      },
      clipboardTextSerializer: (slice) => slice.content.textBetween(0, slice.content.size, '\n'),
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    if (autofocus) view.focus();
    return () => {
      disposed = true;
      view?.destroy();
      view = undefined;
    };
  });
  $effect(() => {
    const value = restore;
    if (
      !view ||
      !value ||
      value.version === restoredVersion ||
      value.bookmark.markerId !== marker.id ||
      value.bookmark.imageId !== imageId
    )
      return;
    restoredVersion = value.version;
    const doc = toDoc(marker.translation),
      max = doc.content.size;
    const selection = TextSelection.create(
      doc,
      Math.min(max - 1, Math.max(1, value.bookmark.anchor)),
      Math.min(max - 1, Math.max(1, value.bookmark.head)),
    );
    view.updateState(
      EditorState.create({
        schema,
        doc,
        selection,
        storedMarks: value.bookmark.storedMarks.map((mark) => schema.mark(mark)),
        plugins: view.state.plugins,
      }),
    );
    view.focus();
    active = value.bookmark.storedMarks;
    group = '';
  });
</script>

<div class="translation-editor">
  <div class="format-toolbar" aria-label="文字格式">
    {#each marks as mark, index}
      <button
        class:chosen={active.includes(mark)}
        aria-label={['加粗', '斜体', '删除线', '着重点'][index]}
        title={['加粗 (Ctrl/⌘+B)', '斜体 (Ctrl/⌘+I)', '删除线', '着重点'][index]}
        onpointerdown={(event) => event.preventDefault()}
        onclick={() => format(mark)}>{['B', 'I', 'S', 'Ȧ'][index]}</button
      >
    {/each}
    <span class="muted text-xs ml-auto">自动记录编辑</span>
  </div>
  {#if marker.translation.raw}<div class="raw-notice">
      此译文保留了旧格式原文；编辑后将按当前内容重新编码。
    </div>{/if}
  <div class="editor-content" bind:this={element}></div>
</div>
