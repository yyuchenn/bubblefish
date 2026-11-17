import { describe, expect, it } from 'vitest';
import { rebaseTextChange, textChange } from '../src/runtime/text-rebase';

describe('pending input rebasing', () => {
  it('preserves positions when a hook replaces characters of the same UTF-16 length', () => {
    expect(rebaseTextChange('hello', 'HELLO', textChange('hello', 'he!llo'))?.text).toBe('HE!LLO');
    expect(rebaseTextChange('中文😀', '终文😀', textChange('中文😀', '中文😀!'))?.text).toBe(
      '终文😀!',
    );
  });
  it('replays multiple pending edits on the preceding acknowledged result', () => {
    const first = rebaseTextChange(' hello', 'hello', textChange(' hello', ' hello!'))!;
    expect(first.text).toBe('hello!');
    expect(rebaseTextChange(' hello!', first.text, textChange(' hello!', ' hello!?'))?.text).toBe(
      'hello!?',
    );
  });
  it('retains ambiguity instead of overwriting the hook rewrite', () => {
    expect(
      rebaseTextChange(
        'prefix suffix',
        'rewritten',
        textChange('prefix suffix', 'prefix new suffix'),
      ),
    ).toBeNull();
    expect(rebaseTextChange('abcd', 'aXd', { from: 1, to: 3, insert: 'Y' })).toBeNull();
  });
  it('never splits a surrogate pair when computing candidate replacements', () => {
    const change = textChange('a😀z', 'a😃z');
    expect(change).toEqual({ from: 1, to: 3, insert: '😃' });
    expect(rebaseTextChange('a😀z', 'A😀Z', change)?.text).toBe('A😃Z');
  });
  it('maps append input after host trimming and rejects invalid ranges', () => {
    expect(rebaseTextChange('hello ', 'hello', textChange('hello ', 'hello !'))?.text).toBe(
      'hello!',
    );
    expect(rebaseTextChange('x', 'x', { from: 2, to: 2, insert: 'bad' })).toBeNull();
  });
});
