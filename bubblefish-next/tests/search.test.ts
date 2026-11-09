import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDocument, RichText } from '../src/generated/core';
import {
  applySearchTextEdits,
  collectSearchFields,
  findSearchMatches,
  prepareSearchReplacement,
  replaceRichTextRanges,
  type SearchField,
  type SearchOptions,
  type SearchWorkerRequest,
} from '../src/runtime/search';
import { SearchService } from '../src/runtime/search-client';

const defaults: SearchOptions = {
  query: 'cat',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  includeOriginal: false,
  includeMachine: false,
};
const field = (text: string, patch: Partial<SearchField> = {}): SearchField => ({
  projectId: 'project',
  imageId: 'image',
  markerId: 'marker',
  field: 'translation',
  filename: 'page.png',
  page: 1,
  markerNumber: 1,
  text,
  ...patch,
});
const options = (patch: Partial<SearchOptions> = {}): SearchOptions => ({ ...defaults, ...patch });

describe('project search fields', () => {
  it('flattens rich text and includes only actual assistance strings in document order', () => {
    const marker = (id: string, bunnyCache?: unknown) => ({
      id,
      geometry: { type: 'point', x: 0.1, y: 0.2 },
      translation: {
        runs: [
          { text: 'ca', marks: ['bold'] },
          { text: 't', marks: [] },
        ],
      },
      style: { horizontal: false, overlayText: false },
      bunnyCache,
    });
    const project = {
      id: 'p',
      name: 'test',
      sourceLanguage: 'japanese',
      targetLanguage: 'simplifiedChinese',
      images: [
        {
          id: 'first',
          filename: 'one.png',
          markers: [
            marker('a', { originalText: '', machineTranslation: 'mt', extra: 'ignore' }),
            marker('b', { originalText: 1, machineTranslation: null }),
            marker('c', ['not-an-object']),
          ],
        },
        { id: 'second', filename: 'two.png', markers: [marker('d')] },
      ],
    } as unknown as ProjectDocument;
    const fields = collectSearchFields(project);
    expect(
      fields.map(({ imageId, markerId, field, text, page, markerNumber }) => [
        imageId,
        markerId,
        field,
        text,
        page,
        markerNumber,
      ]),
    ).toEqual([
      ['first', 'a', 'translation', 'cat', 1, 1],
      ['first', 'a', 'originalText', '', 1, 1],
      ['first', 'a', 'machineTranslation', 'mt', 1, 1],
      ['first', 'b', 'translation', 'cat', 1, 2],
      ['first', 'c', 'translation', 'cat', 1, 3],
      ['second', 'd', 'translation', 'cat', 2, 1],
    ]);
    expect(fields.every((entry) => entry.projectId === 'p')).toBe(true);
    expect(fields.at(-1)?.filename).toBe('two.png');
  });
});

describe('search expressions', () => {
  it('defaults to translation, with independent original and machine switches', () => {
    const fields = [
      field('cat'),
      field('cat', { field: 'originalText' }),
      field('cat', { field: 'machineTranslation' }),
    ];
    expect(findSearchMatches(fields, defaults).map((match) => match.field)).toEqual([
      'translation',
    ]);
    expect(
      findSearchMatches(fields, options({ includeOriginal: true })).map((match) => match.field),
    ).toEqual(['translation', 'originalText']);
    expect(
      findSearchMatches(fields, options({ includeMachine: true })).map((match) => match.field),
    ).toEqual(['translation', 'machineTranslation']);
  });

  it('uses literal case-insensitive non-overlapping matching and stable field/range keys', () => {
    const fields = [field('Cat cat CAT'), field('cat', { markerId: 'other' })];
    const matches = findSearchMatches(fields, defaults);
    expect(
      matches.map(({ from, to, index, matchedText }) => [from, to, index, matchedText]),
    ).toEqual([
      [0, 3, 0, 'Cat'],
      [4, 7, 1, 'cat'],
      [8, 11, 2, 'CAT'],
      [0, 3, 3, 'cat'],
    ]);
    expect(new Set(matches.map((match) => match.key)).size).toBe(4);
    expect(findSearchMatches(fields, defaults).map((match) => match.key)).toEqual(
      matches.map((match) => match.key),
    );
    expect(findSearchMatches(fields, options({ caseSensitive: true }))).toHaveLength(2);
    expect(
      findSearchMatches([field('aaaa')], options({ query: 'aa' })).map((match) => match.from),
    ).toEqual([0, 2]);
    expect(findSearchMatches([field('a.b [x] $')], options({ query: '.b [x] $' }))).toMatchObject([
      { from: 1, to: 9 },
    ]);
    expect(findSearchMatches(fields, options({ query: '' }))).toEqual([]);
  });

  it('defines Unicode word boundaries with letters, marks, numbers and connectors', () => {
    const matches = findSearchMatches(
      [field('cat cats _cat cat_ 猫cat cat猫 😀cat! cat\u0301 (cat)')],
      options({ wholeWord: true }),
    );
    expect(matches).toHaveLength(3);
    expect(matches.map((match) => match.text.slice(match.from, match.to))).toEqual([
      'cat',
      'cat',
      'cat',
    ]);
    expect(
      findSearchMatches([field('猫 猫咪')], options({ query: '猫', wholeWord: true })),
    ).toHaveLength(1);
  });

  it('supports multiline anchors, invalid-expression errors and Unicode zero-width matches', () => {
    expect(
      findSearchMatches([field('cat\nCat')], options({ query: '^cat$', regex: true })),
    ).toHaveLength(2);
    expect(() => findSearchMatches([field('cat')], options({ query: '[', regex: true }))).toThrow(
      '正则表达式无效',
    );
    expect(
      findSearchMatches([field('😀')], options({ query: '^|$', regex: true })).map((match) => [
        match.from,
        match.to,
      ]),
    ).toEqual([
      [0, 0],
      [2, 2],
    ]);
    expect(
      findSearchMatches([field('a😀b')], options({ query: '(?=.)', regex: true })).map(
        (match) => match.from,
      ),
    ).toEqual([0, 1, 3]);
    expect(findSearchMatches([field('')], options({ query: '^$', regex: true }))).toMatchObject([
      { from: 0, to: 0, matchedText: '' },
    ]);
  });

  it('counts a full-sized project without truncating unseen matches', () => {
    const fields = Array.from({ length: 15_000 }, (_, markerNumber) =>
      field('cat cat', { markerId: String(markerNumber), markerNumber: markerNumber + 1 }),
    );
    const matches = findSearchMatches(fields, defaults);
    expect(matches).toHaveLength(30_000);
    expect(matches.at(-1)?.index).toBe(29_999);
  });
});

describe('prepared replacements', () => {
  it('replaces all original occurrences once, treats non-regex replacement as literal and skips no-ops', () => {
    const fields = [field('cat cat')];
    const prepared = prepareSearchReplacement(fields, defaults, '$1 cat');
    expect(prepared.matchCount).toBe(2);
    expect(prepared.changes).toMatchObject([
      {
        before: 'cat cat',
        after: '$1 cat $1 cat',
        edits: [
          { from: 0, to: 3, insert: '$1 cat' },
          { from: 4, to: 7, insert: '$1 cat' },
        ],
      },
    ]);
    expect(prepareSearchReplacement(fields, defaults, 'cat')).toEqual({
      changes: [],
      matchCount: 0,
    });
    expect(prepareSearchReplacement(fields, options({ query: '' }), 'anything')).toEqual({
      changes: [],
      matchCount: 0,
    });
    expect(prepareSearchReplacement(fields, defaults, '').changes[0].after).toBe(' ');
  });

  it.each([
    ['$2-$1', '(c)(at)'],
    ['$01:$10:$12:$99:$0:$00', '(c)(at)'],
    ['$<word>:$<missing>:$$:$&', '(?<word>cat)'],
    ['$1:$2:$3:$<word>', '(c)(at)(z)?'],
    ["$`<$&>$'", '(cat)'],
    ['$1$2', '(c)(at)|(dog)'],
  ])('expands %s exactly like native string replacement for %s', (replacement, query) => {
    const text = 'before cat cat dog after';
    const result = prepareSearchReplacement(
      [field(text)],
      options({ query, regex: true }),
      replacement,
    );
    expect(result.changes[0]?.after ?? text).toBe(
      text.replace(new RegExp(query, 'gimu'), replacement),
    );
  });

  it('replaces only the selected match and rejects changed or removed source results', () => {
    const fields = [field('cat cat')];
    const current = findSearchMatches(fields, defaults)[1];
    expect(prepareSearchReplacement(fields, defaults, 'dog', current)).toMatchObject({
      matchCount: 1,
      changes: [{ after: 'cat dog' }],
    });
    expect(() =>
      prepareSearchReplacement([field('cat changed cat')], defaults, 'dog', current),
    ).toThrow('查找结果已变化');
    expect(() => prepareSearchReplacement([], defaults, 'dog', current)).toThrow('查找结果已变化');
    expect(() => prepareSearchReplacement(fields, options({ query: 'dog' }), 'x', current)).toThrow(
      '查找结果已变化',
    );
    expect(prepareSearchReplacement(fields, defaults, 'cat', current)).toEqual({
      matchCount: 0,
      changes: [],
    });
  });

  it('inserts at zero-width Unicode matches without searching the inserted text again', () => {
    expect(
      prepareSearchReplacement([field('😀')], options({ query: '^|$', regex: true }), '!'),
    ).toMatchObject({ matchCount: 2, changes: [{ after: '!😀!' }] });
    expect(
      prepareSearchReplacement([field('')], options({ query: '^$', regex: true }), 'cat'),
    ).toMatchObject({ matchCount: 1, changes: [{ after: 'cat' }] });
    expect(
      prepareSearchReplacement([field('')], options({ query: '^$', regex: true }), ''),
    ).toEqual({ matchCount: 0, changes: [] });
  });
});

describe('formatted range replacement', () => {
  const rich: RichText = {
    runs: [
      { text: 'pre ca', marks: ['bold'] },
      { text: 't middle', marks: ['italic'] },
      { text: ' end', marks: [] },
    ],
    raw: 'legacy source',
  };

  it('retains unaffected runs and inherits the first matched character format across run boundaries', () => {
    const replacement = replaceRichTextRanges(rich, [{ from: 4, to: 7, insert: 'dog' }]);
    expect(replacement).toEqual({
      runs: [
        { text: 'pre dog', marks: ['bold'] },
        { text: ' middle', marks: ['italic'] },
        { text: ' end', marks: [] },
      ],
    });
    expect(rich.raw).toBe('legacy source');
    expect(rich.runs[0].text).toBe('pre ca');
    expect(replacement.runs[0].marks).not.toBe(rich.runs[0].marks);
  });

  it('inherits zero-width insertions from the right at boundaries and the left at EOF', () => {
    expect(
      replaceRichTextRanges(rich, [
        { from: 6, to: 6, insert: 'R' },
        { from: 18, to: 18, insert: 'L' },
      ]),
    ).toEqual({
      runs: [
        { text: 'pre ca', marks: ['bold'] },
        { text: 'Rt middle', marks: ['italic'] },
        { text: ' endL', marks: [] },
      ],
    });
    expect(
      replaceRichTextRanges({ runs: [], raw: 'unknown' }, [{ from: 0, to: 0, insert: 'new' }]),
    ).toEqual({ runs: [{ text: 'new', marks: [] }] });
  });

  it('supports deletion, multiple edits and newlines while retaining raw on textual no-ops', () => {
    expect(replaceRichTextRanges(rich, [{ from: 0, to: 18, insert: '' }])).toEqual({ runs: [] });
    expect(replaceRichTextRanges(rich, [{ from: 4, to: 7, insert: 'cat' }])).toBe(rich);
    expect(replaceRichTextRanges(rich, [])).toBe(rich);
    expect(
      replaceRichTextRanges(rich, [
        { from: 0, to: 3, insert: 'first\nnext' },
        { from: 14, to: 18, insert: '!' },
      ]),
    ).toEqual({
      runs: [
        { text: 'first\nnext ca', marks: ['bold'] },
        { text: 't middle', marks: ['italic'] },
        { text: '!', marks: [] },
      ],
    });
  });

  it('rejects overlapping, non-integer, out-of-bounds and surrogate-splitting edits', () => {
    for (const edits of [
      [{ from: 2, to: 1, insert: '' }],
      [{ from: -1, to: 1, insert: '' }],
      [{ from: 0, to: 4, insert: '' }],
      [{ from: 1.5, to: 2, insert: '' }],
      [{ from: 1, to: 2, insert: '' }],
      [
        { from: 0, to: 2, insert: '' },
        { from: 1, to: 2, insert: '' },
      ],
    ])
      expect(() => applySearchTextEdits('😀x', edits)).toThrow('替换范围无效');
  });
});

class FakeWorker {
  onmessage?: (event: MessageEvent) => void;
  onerror?: (event: ErrorEvent) => void;
  onmessageerror?: () => void;
  postMessage = vi.fn<(request: SearchWorkerRequest) => void>();
  terminate = vi.fn();
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('dispatches actual worker requests and returns serializable failures with their request ID', async () => {
  const scope: {
    onmessage?: (event: MessageEvent<SearchWorkerRequest>) => void;
    postMessage: ReturnType<typeof vi.fn>;
  } = { postMessage: vi.fn() };
  vi.stubGlobal('self', scope);
  await import('../src/runtime/search-worker');
  const fields = [field('cat cat')];
  scope.onmessage!({
    data: { id: 1, type: 'search', fields, options: defaults },
  } as MessageEvent<SearchWorkerRequest>);
  expect(scope.postMessage).toHaveBeenLastCalledWith({
    id: 1,
    result: findSearchMatches(fields, defaults),
  });
  scope.onmessage!({
    data: { id: 2, type: 'replace', fields, options: defaults, replacement: 'dog' },
  } as MessageEvent<SearchWorkerRequest>);
  expect(scope.postMessage).toHaveBeenLastCalledWith({
    id: 2,
    result: prepareSearchReplacement(fields, defaults, 'dog'),
  });
  scope.onmessage!({
    data: { id: 3, type: 'search', fields, options: options({ regex: true, query: '[' }) },
  } as MessageEvent<SearchWorkerRequest>);
  expect(scope.postMessage).toHaveBeenLastCalledWith({
    id: 3,
    error: expect.stringContaining('正则表达式无效'),
  });
});

describe('search worker lifecycle', () => {
  function service() {
    const workers: FakeWorker[] = [];
    const create = vi.fn(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    return { client: new SearchService(create), workers, create };
  }

  it('posts search/prepare snapshots, checks request IDs and releases workers on success', async () => {
    const { client, workers } = service();
    const fields = [field('cat')];
    const searching = client.search(fields, defaults);
    expect(workers[0].postMessage).toHaveBeenCalledWith({
      id: 1,
      type: 'search',
      fields,
      options: defaults,
    });
    workers[0].reply({ id: 99, result: [] });
    expect(workers[0].terminate).not.toHaveBeenCalled();
    const matches = findSearchMatches(fields, defaults);
    workers[0].reply({ id: 1, result: matches });
    await expect(searching).resolves.toEqual(matches);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    const preparing = client.prepareReplacement(fields, defaults, 'dog', matches[0]);
    expect(workers[1].postMessage).toHaveBeenCalledWith({
      id: 2,
      type: 'replace',
      fields,
      options: defaults,
      replacement: 'dog',
      current: matches[0],
    });
    const prepared = prepareSearchReplacement(fields, defaults, 'dog', matches[0]);
    workers[1].reply({ id: 2, result: prepared });
    await expect(preparing).resolves.toEqual(prepared);
    expect(workers[1].terminate).toHaveBeenCalledOnce();
    client.dispose();
  });

  it('terminates superseded work and ignores a late reply without affecting the newer request', async () => {
    const { client, workers } = service();
    const first = client.search([field('cat')], defaults);
    const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = client.search([field('dog')], options({ query: 'dog' }));
    await cancelled;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    workers[0].reply({ id: 1, result: ['old'] });
    expect(workers[1].terminate).not.toHaveBeenCalled();
    workers[1].reply({ id: 2, result: [] });
    await expect(second).resolves.toEqual([]);
    client.dispose();
  });

  it('times out uncooperative expressions after two seconds and permits the next query', async () => {
    vi.useFakeTimers();
    const { client, workers } = service();
    const first = client.search([field('cat')], defaults);
    const timeout = expect(first).rejects.toThrow('查找超时');
    await vi.advanceTimersByTimeAsync(1999);
    expect(workers[0].terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await timeout;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    const next = client.search([], defaults);
    workers[1].reply({ id: 2, result: [] });
    await expect(next).resolves.toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    client.dispose();
  });

  it.each(['reply', 'error', 'messageerror', 'post'] as const)(
    'cleans up a %s failure and leaves the service reusable',
    async (kind) => {
      const { client, workers } = service();
      if (kind === 'post') {
        const worker = new FakeWorker();
        worker.postMessage.mockImplementation(() => {
          throw new Error('cannot clone');
        });
        const failing = new SearchService(() => worker as unknown as Worker);
        await expect(failing.search([], defaults)).rejects.toThrow('cannot clone');
        expect(worker.terminate).toHaveBeenCalledOnce();
        failing.dispose();
      } else {
        const pending = client.search([], defaults);
        const failure = expect(pending).rejects.toThrow();
        if (kind === 'reply') workers[0].reply({ id: 1, error: 'invalid regex' });
        if (kind === 'error')
          workers[0].onerror?.({
            message: 'crashed',
            preventDefault: vi.fn(),
          } as unknown as ErrorEvent);
        if (kind === 'messageerror') workers[0].onmessageerror?.();
        await failure;
        expect(workers[0].terminate).toHaveBeenCalledOnce();
      }
      const next = client.search([], defaults);
      const latest = workers.at(-1)!;
      latest.reply({ id: latest.postMessage.mock.calls[0][0].id, result: [] });
      await expect(next).resolves.toEqual([]);
      client.dispose();
    },
  );

  it('supports explicit cancellation and disposal without starting more workers', async () => {
    const { client, workers, create } = service();
    const pending = client.search([], defaults);
    const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    client.cancel();
    client.cancel();
    await cancelled;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    client.dispose();
    await expect(client.search([], defaults)).rejects.toThrow('查找服务已关闭');
    expect(create).toHaveBeenCalledOnce();
  });

  it('keeps search and preparation on separate service instances independent', async () => {
    const search = service(),
      replace = service();
    const searching = search.client.search([], defaults);
    const preparing = replace.client.prepareReplacement([], defaults, 'dog');
    const cancelled = expect(searching).rejects.toMatchObject({ name: 'AbortError' });
    search.client.dispose();
    await cancelled;
    expect(replace.workers[0].terminate).not.toHaveBeenCalled();
    replace.workers[0].reply({ id: 1, result: { changes: [], matchCount: 0 } });
    await expect(preparing).resolves.toEqual({ changes: [], matchCount: 0 });
    replace.client.dispose();
  });

  it('rejects worker startup failures and retries with a fresh worker', async () => {
    const worker = new FakeWorker();
    const create = vi
      .fn<() => Worker>()
      .mockImplementationOnce(() => {
        throw new Error('worker unavailable');
      })
      .mockReturnValueOnce(worker as unknown as Worker);
    const client = new SearchService(create);
    await expect(client.search([], defaults)).rejects.toThrow('worker unavailable');
    const next = client.search([], defaults);
    worker.reply({ id: 2, result: [] });
    await expect(next).resolves.toEqual([]);
    client.dispose();
  });
});
