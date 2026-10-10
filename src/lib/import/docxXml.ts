import { collector, fail, IMPORT_LIMITS as L, labelled, type ImportedTranscript } from './types';

const WORD = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
const NAME = '[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?';
const OPEN = new RegExp(`^<(${NAME})`);
const ATTR = new RegExp(`\\s+(${NAME})\\s*=\\s*("[^"<]*"|'[^'<]*')`, 'y');
const CLOSE = new RegExp(`^</(${NAME})\\s*>$`);

function entities(text: string): string {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(text)) fail('MALFORMED_INPUT');
  return text.replace(/&([^;]+);/g, (_, key: string) => {
    const builtin: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (builtin[key]) return builtin[key];
    const code = key.startsWith('#x') ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    if (!Number.isInteger(code) || !(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff)
      || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff))) fail('MALFORMED_INPUT');
    return String.fromCodePoint(code);
  });
}

/** Bounded XML subset, not an HTML parser or a general-purpose OOXML renderer. */
export function paragraphs(xml: string): ImportedTranscript {
  xml = xml.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.test(xml)) fail('MALFORMED_INPUT');
  const out = collector();
  out.warnings.add('DOCX_BODY_PARAGRAPHS_ONLY');
  const stack: { name: string; local: string; word: boolean; ns: Map<string, string> }[] = [];
  let position = 0;
  let nodes = 0;
  let roots = 0;
  let bodies = 0;
  let paragraph: string[] | null = null;
  let paragraphBytes = 0;
  let paragraphCount = 0;
  function append(text: string) {
    if (paragraph === null) fail('MALFORMED_INPUT');
    paragraphBytes += new TextEncoder().encode(text).length;
    if (paragraphBytes > L.turnBytes) fail('TEXT_TOO_LARGE');
    paragraph.push(text);
  }
  function close() {
    const node = stack.pop()!;
    if (node.word && node.local === 'p') {
      const text = paragraph!.join('');
      if (text.trim()) {
        const turn = labelled(text);
        if (turn.speaker !== 'Unknown') out.warnings.add('SPEAKER_LABELS_INFERRED');
        out.add(turn);
      } else out.warnings.add('EMPTY_PARAGRAPHS_IGNORED');
      paragraph = null;
    }
  }
  while (position < xml.length) {
    if (xml[position] !== '<') {
      const next = xml.indexOf('<', position);
      const end = next < 0 ? xml.length : next;
      const source = xml.slice(position, end);
      if (source.includes(']]>')) fail('MALFORMED_INPUT');
      const text = entities(source);
      const parent = stack[stack.length - 1];
      if (parent?.word && parent.local === 't') append(text);
      else if (text.trim()) fail('UNSUPPORTED_FORMAT');
      position = end;
      continue;
    }
    if (xml.startsWith('<!--', position)) {
      const end = xml.indexOf('-->', position + 4);
      if (end < 0 || xml.slice(position + 4, end).includes('--') || xml[end - 1] === '-') fail('MALFORMED_INPUT');
      position = end + 3;
      continue;
    }
    if (xml.startsWith('<?xml ', position) && position === 0) {
      const end = xml.indexOf('?>', position);
      const declaration = xml.slice(position, end + 2);
      if (end < 0 || !/^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"UTF-8"|'UTF-8'))?(?:\s+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>$/i.test(declaration)) fail('UNSUPPORTED_FORMAT');
      position = end + 2;
      continue;
    }
    // No DTDs, entity definitions, CDATA, or processing instructions.
    if (xml.startsWith('<!', position) || xml.startsWith('<?', position)) fail('UNSUPPORTED_FORMAT');
    const token = /^<(?:[^<>"']|"[^"<]*"|'[^'<]*')*>/.exec(xml.slice(position))?.[0];
    if (!token) fail('MALFORMED_INPUT');
    position += token.length;
    if (++nodes > L.xmlNodes) fail('ARCHIVE_LIMIT');
    if (token.startsWith('</')) {
      const name = CLOSE.exec(token)?.[1];
      if (!name || stack[stack.length - 1]?.name !== name) fail('MALFORMED_INPUT');
      close();
      continue;
    }
    const match = OPEN.exec(token);
    if (!match) fail('MALFORMED_INPUT');
    let cursor = match[0].length;
    const attrs = new Map<string, string>();
    while (cursor < token.length) {
      ATTR.lastIndex = cursor;
      const attr = ATTR.exec(token);
      if (!attr) break;
      if (attrs.has(attr[1])) fail('MALFORMED_INPUT');
      attrs.set(attr[1], entities(attr[2].slice(1, -1)));
      cursor = ATTR.lastIndex;
    }
    if (!/^\s*\/?>$/.test(token.slice(cursor))) fail('MALFORMED_INPUT');
    const ns = new Map(stack[stack.length - 1]?.ns ?? [['xml', 'http://www.w3.org/XML/1998/namespace']]);
    for (const [key, value] of attrs) {
      if (key === 'xmlns') ns.set('', value);
      else if (key.startsWith('xmlns:')) {
        if (key === 'xmlns:xmlns' || !value || (key === 'xmlns:xml' && value !== 'http://www.w3.org/XML/1998/namespace')) fail('MALFORMED_INPUT');
        ns.set(key.slice(6), value);
      }
    }
    const name = match[1];
    const [prefix, local] = name.includes(':') ? name.split(':') : ['', name];
    if (prefix && !ns.has(prefix)) fail('MALFORMED_INPUT');
    for (const key of attrs.keys()) {
      if (key.includes(':') && !key.startsWith('xmlns:') && !ns.has(key.split(':')[0])) fail('MALFORMED_INPUT');
    }
    const expandedAttributes = new Set<string>();
    for (const key of attrs.keys()) {
      if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
      const [attributePrefix, attributeLocal] = key.includes(':') ? key.split(':') : ['', key];
      const expanded = `${attributePrefix ? ns.get(attributePrefix) : ''}#${attributeLocal}`;
      if (expandedAttributes.has(expanded)) fail('MALFORMED_INPUT');
      expandedAttributes.add(expanded);
    }
    const word = WORD.has(ns.get(prefix) ?? '');
    if (!word) fail('UNSUPPORTED_FORMAT');
    if (!stack.length) {
      if (++roots !== 1 || !word || local !== 'document') fail('MALFORMED_INPUT');
    }
    if (word && local === 'body') {
      if (++bodies !== 1 || stack.length !== 1) fail('MALFORMED_INPUT');
    }
    if (word && ['altChunk', 'object', 'drawing', 'pict', 'txbxContent', 'ins', 'del', 'instrText', 'fldSimple', 'fldChar'].includes(local)) fail('UNSUPPORTED_FORMAT');
    if (word && local === 'p') {
      if (paragraph !== null || !stack.some(node => node.word && node.local === 'body')) fail('MALFORMED_INPUT');
      if (++paragraphCount > L.turns) fail('TOO_MANY_TURNS');
      paragraph = [];
      paragraphBytes = 0;
    }
    if (stack.some(node => node.word && node.local === 't')) fail('MALFORMED_INPUT');
    if (word && local === 't' && paragraph === null) fail('MALFORMED_INPUT');
    if (word && (local === 'tab' || local === 'br' || local === 'cr')) append(local === 'tab' ? '\t' : '\n');
    if (word && ['sym', 'noBreakHyphen', 'softHyphen'].includes(local)) fail('UNSUPPORTED_FORMAT');
    stack.push({ name, local, word, ns });
    if (stack.length > L.xmlDepth) fail('ARCHIVE_LIMIT');
    if (token.endsWith('/>')) close();
  }
  if (stack.length || roots !== 1 || bodies !== 1) fail('MALFORMED_INPUT');
  return out.finish();
}
