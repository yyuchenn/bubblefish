import bootstrap from './panel-theme-bootstrap.js?raw';
import foundation from './panel-theme.css?raw';

export const PANEL_THEME_MARKER = '<!-- bubblefish:panel-theme:v1 -->';

function tagEnd(html: string, from: number) {
  let quote = '';
  for (let index = from; index < html.length; index++) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index + 1;
  }
  return undefined;
}

/** Find the real leading head, never a head-like string in plugin code or comments. */
function injectionPoint(html: string) {
  let cursor = html.startsWith('\uFEFF') ? 1 : 0;
  let fallback = cursor;
  while (cursor < html.length) {
    cursor += html.slice(cursor).match(/^[\t\n\f\r ]*/)?.[0].length ?? 0;
    if (html.startsWith('<!--', cursor)) {
      const end = html.indexOf('-->', cursor + 4);
      if (end === -1) break;
      cursor = end + 3;
      continue;
    }
    const tag = html
      .slice(cursor)
      .match(/^<(head|html|!doctype)(?=[\t\n\f\r />])/i)?.[1]
      ?.toLowerCase();
    if (!tag) break;
    const end = tagEnd(html, cursor);
    if (end === undefined) break;
    if (tag === 'head') return end;
    if (tag === '!doctype') fallback = end;
    cursor = end;
  }
  return fallback;
}

/** Ephemeral host decoration; installation bytes are never rewritten. */
export function injectPanelTheme(html: string): string {
  if (html.includes(PANEL_THEME_MARKER)) return html;
  const offset = injectionPoint(html);
  const styles = foundation.replace(/<\/style/gi, '<\\/style');
  const script = bootstrap.replace(/<\/script/gi, '<\\/script');
  return `${html.slice(0, offset)}${PANEL_THEME_MARKER}<style id="bf-panel-foundation">${styles}</style><script id="bf-panel-theme-bootstrap">${script}</script>${html.slice(offset)}`;
}
