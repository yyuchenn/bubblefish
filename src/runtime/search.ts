import type { ProjectDocument, RichText, TextMark, TextRun } from '../generated/core';

export type SearchFieldKind = 'translation' | 'originalText' | 'machineTranslation';

export interface SearchOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  includeOriginal: boolean;
  includeMachine: boolean;
}

export interface SearchField {
  projectId: string;
  imageId: string;
  markerId: string;
  field: SearchFieldKind;
  filename: string;
  page: number;
  markerNumber: number;
  text: string;
}

/** Text ranges use UTF-16 offsets, matching textarea and ProseMirror text offsets. */
export interface SearchMatch extends SearchField {
  from: number;
  to: number;
  index: number;
  key: string;
  matchedText: string;
}

export interface SearchTextEdit {
  from: number;
  to: number;
  insert: string;
}

export interface SearchFieldReplacement {
  projectId: string;
  imageId: string;
  markerId: string;
  field: SearchFieldKind;
  before: string;
  after: string;
  edits: SearchTextEdit[];
  matchCount: number;
}

export interface PreparedSearchReplacement {
  changes: SearchFieldReplacement[];
  matchCount: number;
}

export type SearchWorkerRequest =
  | { id: number; type: 'search'; fields: SearchField[]; options: SearchOptions }
  | {
      id: number;
      type: 'replace';
      fields: SearchField[];
      options: SearchOptions;
      replacement: string;
      current?: SearchMatch;
    };

export type SearchWorkerReply =
  | { id: number; result: SearchMatch[] | PreparedSearchReplacement; error?: never }
  | { id: number; result?: never; error: string };

/** Collect every stored field once; scope switches are applied by the worker. */
export function collectSearchFields(project: ProjectDocument): SearchField[] {
  return project.images.flatMap((image, page) =>
    image.markers.flatMap((marker, markerNumber) => {
      const context = {
        projectId: project.id,
        imageId: image.id,
        markerId: marker.id,
        filename: image.filename,
        page: page + 1,
        markerNumber: markerNumber + 1,
      };
      const fields: SearchField[] = [
        {
          ...context,
          field: 'translation',
          text: marker.translation.runs.map((run) => run.text).join(''),
        },
      ];
      const cache = marker.bunnyCache;
      if (cache && typeof cache === 'object' && !Array.isArray(cache)) {
        for (const field of ['originalText', 'machineTranslation'] as const) {
          const text = cache[field];
          if (typeof text === 'string') fields.push({ ...context, field, text });
        }
      }
      return fields;
    }),
  );
}

const wordCharacter = /[\p{L}\p{M}\p{N}\p{Pc}]/u;

function wholeWord(text: string, from: number, to: number) {
  const before = from > 0 ? text.slice(Math.max(0, from - 2), from) : '';
  const beforePoint = [...before].at(-1) ?? '';
  const after = to < text.length ? String.fromCodePoint(text.codePointAt(to)!) : '';
  return !wordCharacter.test(beforePoint) && !wordCharacter.test(after);
}

function expression(options: SearchOptions): RegExp | null {
  if (!options.query) return null;
  const source = options.regex
    ? options.query
    : options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(source, `gmu${options.caseSensitive ? '' : 'i'}`);
  } catch (error) {
    throw new Error(`正则表达式无效：${error instanceof Error ? error.message : String(error)}`);
  }
}

function enabled(field: SearchField, options: SearchOptions) {
  return (
    field.field === 'translation' ||
    (field.field === 'originalText' && options.includeOriginal) ||
    (field.field === 'machineTranslation' && options.includeMachine)
  );
}

function visitMatches(
  fields: SearchField[],
  options: SearchOptions,
  visit: (match: SearchMatch, capture: RegExpMatchArray) => void,
) {
  const pattern = expression(options);
  if (!pattern) return;
  let index = 0;
  for (const field of fields) {
    if (!enabled(field, options)) continue;
    // matchAll advances zero-width matches by Unicode code point, including at EOF.
    for (const capture of field.text.matchAll(pattern)) {
      const from = capture.index!,
        to = from + capture[0].length;
      if (options.wholeWord && !wholeWord(field.text, from, to)) continue;
      visit(
        {
          ...field,
          from,
          to,
          index: index++,
          key: JSON.stringify([
            field.projectId,
            field.imageId,
            field.markerId,
            field.field,
            from,
            to,
          ]),
          matchedText: capture[0],
        },
        capture,
      );
    }
  }
}

/** Run this only in the dedicated search worker when handling user expressions. */
export function findSearchMatches(fields: SearchField[], options: SearchOptions): SearchMatch[] {
  const results: SearchMatch[] = [];
  visitMatches(fields, options, (match) => results.push(match));
  return results;
}

/** ECMAScript string-replacement tokens, using captures from the original full field. */
function expandReplacement(replacement: string, capture: RegExpMatchArray, text: string) {
  return replacement.replace(/\$(\$|&|`|'|<[^>]*>|[0-9]{1,2})/g, (token, part: string) => {
    if (part === '$') return '$';
    if (part === '&') return capture[0];
    if (part === '`') return text.slice(0, capture.index);
    if (part === "'") return text.slice(capture.index! + capture[0].length);
    if (part.startsWith('<'))
      return capture.groups === undefined ? token : (capture.groups[part.slice(1, -1)] ?? '');
    const number = Number(part);
    if (number > 0 && number < capture.length) return capture[number] ?? '';
    if (part.length === 2 && Number(part[0]) > 0 && Number(part[0]) < capture.length)
      return (capture[Number(part[0])] ?? '') + part[1];
    return token;
  });
}

function assertEdits(text: string, edits: SearchTextEdit[]) {
  let end = 0;
  const boundary = (position: number) =>
    position === 0 ||
    position === text.length ||
    !(
      text.charCodeAt(position - 1) >= 0xd800 &&
      text.charCodeAt(position - 1) <= 0xdbff &&
      text.charCodeAt(position) >= 0xdc00 &&
      text.charCodeAt(position) <= 0xdfff
    );
  for (const edit of edits) {
    if (
      !Number.isInteger(edit.from) ||
      !Number.isInteger(edit.to) ||
      edit.from < end ||
      edit.to < edit.from ||
      edit.to > text.length ||
      !boundary(edit.from) ||
      !boundary(edit.to)
    )
      throw new Error('替换范围无效或相互重叠');
    end = edit.to;
  }
}

export function applySearchTextEdits(text: string, edits: SearchTextEdit[]): string {
  assertEdits(text, edits);
  const parts: string[] = [];
  let from = 0;
  for (const edit of edits) {
    parts.push(text.slice(from, edit.from), edit.insert);
    from = edit.to;
  }
  parts.push(text.slice(from));
  return parts.join('');
}

/** Prepare edits against the supplied immutable snapshot; a current result must still match it. */
export function prepareSearchReplacement(
  fields: SearchField[],
  options: SearchOptions,
  replacement: string,
  current?: SearchMatch,
): PreparedSearchReplacement {
  const grouped = new Map<string, { field: SearchField; edits: SearchTextEdit[] }>();
  let foundCurrent = !current;
  visitMatches(fields, options, (match, capture) => {
    if (current) {
      if (match.key !== current.key) return;
      if (
        match.text !== current.text ||
        match.matchedText !== current.matchedText ||
        match.from !== current.from ||
        match.to !== current.to
      )
        throw new Error('查找结果已变化，请重新查找');
      foundCurrent = true;
    }
    const insert = options.regex
      ? expandReplacement(replacement, capture, match.text)
      : replacement;
    if (insert === match.matchedText) return;
    const key = JSON.stringify([match.projectId, match.imageId, match.markerId, match.field]);
    let entry = grouped.get(key);
    if (!entry) {
      entry = { field: match, edits: [] };
      grouped.set(key, entry);
    }
    entry.edits.push({ from: match.from, to: match.to, insert });
  });
  if (!foundCurrent) throw new Error('查找结果已变化，请重新查找');
  const changes: SearchFieldReplacement[] = [];
  for (const { field, edits } of grouped.values()) {
    const after = applySearchTextEdits(field.text, edits);
    if (after === field.text) continue;
    changes.push({
      projectId: field.projectId,
      imageId: field.imageId,
      markerId: field.markerId,
      field: field.field,
      before: field.text,
      after,
      edits,
      matchCount: edits.length,
    });
  }
  return { changes, matchCount: changes.reduce((count, change) => count + change.matchCount, 0) };
}

/** Preserve untouched runs; inserted text inherits the first replaced character's formatting. */
export function replaceRichTextRanges(value: RichText, edits: SearchTextEdit[]): RichText {
  const text = value.runs.map((run) => run.text).join('');
  if (applySearchTextEdits(text, edits) === text) return value;
  let position = 0;
  const spans = value.runs.flatMap((run) => {
    const from = position;
    position += run.text.length;
    return run.text ? [{ ...run, from, to: position }] : [];
  });
  const runs: TextRun[] = [];
  const append = (text: string, marks: TextMark[]) => {
    if (!text) return;
    const previous = runs.at(-1);
    if (previous && previous.marks.join() === marks.join()) previous.text += text;
    else runs.push({ text, marks: [...marks] });
  };
  const marksAt = (offset: number): TextMark[] => {
    let low = 0,
      high = spans.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (spans[middle].to <= offset) low = middle + 1;
      else high = middle;
    }
    return (spans[low] ?? spans.at(-1))?.marks ?? [];
  };
  let spanIndex = 0;
  const appendOriginal = (from: number, to: number) => {
    while (spanIndex < spans.length && spans[spanIndex].to <= from) spanIndex++;
    while (spanIndex < spans.length && spans[spanIndex].from < to) {
      const span = spans[spanIndex];
      append(
        span.text.slice(Math.max(from, span.from) - span.from, Math.min(to, span.to) - span.from),
        span.marks,
      );
      if (span.to > to) break;
      spanIndex++;
    }
  };
  let from = 0;
  for (const edit of edits) {
    appendOriginal(from, edit.from);
    append(edit.insert, marksAt(edit.from));
    from = edit.to;
  }
  appendOriginal(from, text.length);
  return { runs };
}
