/** A search range addresses UTF-16 offsets in the complete plain-text field. */
export interface SearchHighlight {
  projectId: string;
  imageId: string;
  markerId: string;
  field: 'translation' | 'originalText' | 'machineTranslation';
  from: number;
  to: number;
  text: string;
}

/** ProseMirror has an opening paragraph token and two tokens per line break. */
export function textOffsetToEditorPosition(text: string, offset: number): number {
  const end = Math.max(0, Math.min(text.length, offset));
  let position = 1 + end;
  for (let index = 0; index < end; index++) if (text[index] === '\n') position++;
  return position;
}

export function validSearchRange(highlight: SearchHighlight, text: string): boolean {
  return (
    highlight.text === text &&
    Number.isInteger(highlight.from) &&
    Number.isInteger(highlight.to) &&
    highlight.from >= 0 &&
    highlight.to >= highlight.from &&
    highlight.to <= text.length
  );
}
