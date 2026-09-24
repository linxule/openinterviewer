// A deliberately small reader for .github/workflows/ci.yml (no YAML parser is
// a project dependency). It supports the block subset the workflow uses:
// mappings, sequences, plain/quoted scalars, flow sequences of scalars and
// literal (|) block scalars, and throws on anything else (anchors, aliases,
// tags, flow mappings, tabs) so a construct it cannot read fails the test
// instead of being misread. Also evaluates the GitHub Actions expression
// subset that concurrency settings use.

function fail(lineNumber, message) {
  throw new SyntaxError(`ci.yml line ${lineNumber + 1}: ${message}`);
}

function stripComment(text) {
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if ((char === '"' || char === "'") && (index === 0 || /[\s[,:]/.test(text[index - 1]))) quote = char;
    else if (char === '#' && (index === 0 || /\s/.test(text[index - 1]))) return text.slice(0, index).trimEnd();
  }
  return text.trimEnd();
}

function scalar(raw, lineNumber) {
  const text = raw.trim();
  if (text === '' || text === '~' || text === 'null') return null;
  if (/^[&*!{]/.test(text) || text.startsWith('<<')) fail(lineNumber, `unsupported YAML construct: ${text}`);
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) fail(lineNumber, 'unterminated flow sequence');
    const inner = text.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((item) => scalar(item, lineNumber));
  }
  if (text.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(text)) fail(lineNumber, 'bad single-quoted scalar');
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return fail(lineNumber, 'unsupported double-quoted scalar');
    }
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return text;
}

const KEY = /^((?:[A-Za-z0-9_$./-]+)|'(?:[^']|'')*'|"[^"]*")[ ]*:(?:[ ]+|$)/;

export function parseWorkflowYaml(text) {
  const lines = text.split('\n');
  lines.forEach((line, index) => { if (/^\s*\t/.test(line)) fail(index, 'tab indentation'); });
  let index = 0;
  const isContent = (line) => stripComment(line).trim() !== '';
  const indentOf = (line) => line.match(/^ */)[0].length;
  const skipBlank = () => { while (index < lines.length && !isContent(lines[index])) index += 1; };
  const peek = () => { skipBlank(); return index < lines.length ? lines[index] : null; };

  function blockScalar(parentIndent, header) {
    if (!/^\|[-+]?$/.test(header)) fail(index - 1, `unsupported block scalar header ${header}`);
    const body = [];
    let contentIndent = null;
    while (index < lines.length) {
      const line = lines[index];
      if (line.trim() === '') { body.push(''); index += 1; continue; }
      const indent = indentOf(line);
      if (indent <= parentIndent) break;
      contentIndent ??= indent;
      if (indent < contentIndent) fail(index, 'block scalar indentation decreased');
      body.push(line.slice(contentIndent));
      index += 1;
    }
    while (body.length > 0 && body.at(-1) === '') body.pop();
    const joined = body.join('\n');
    if (header === '|-') return joined;
    return `${joined}\n`;
  }

  function value(rest, keyIndent) {
    const text = stripComment(rest);
    if (text.trim() === '') {
      const next = peek();
      if (next === null) return null;
      const indent = indentOf(next);
      if (indent > keyIndent) return node(indent);
      if (indent === keyIndent && next.trimStart().startsWith('- ')) return sequence(indent);
      return null;
    }
    if (text.trim().startsWith('|') || text.trim().startsWith('>')) return blockScalar(keyIndent, text.trim());
    return scalar(text, index - 1);
  }

  function mapping(indent) {
    const result = {};
    for (;;) {
      const line = peek();
      if (line === null || indentOf(line) < indent) return result;
      if (indentOf(line) > indent) fail(index, 'unexpected indentation');
      const body = line.slice(indent);
      if (body.startsWith('- ')) return result;
      const match = KEY.exec(body);
      if (!match) fail(index, `expected "key:" but found ${body}`);
      const key = scalar(match[1], index);
      if (Object.hasOwn(result, key)) fail(index, `duplicate key ${key}`);
      index += 1;
      result[key] = value(body.slice(match[0].length), indent);
    }
  }

  function sequence(indent) {
    const result = [];
    for (;;) {
      const line = peek();
      if (line === null || indentOf(line) !== indent || !/^- |^-$/.test(line.slice(indent))) return result;
      const after = line.slice(indent + 1);
      const itemIndent = indent + 1 + after.match(/^ */)[0].length;
      const content = line.slice(itemIndent);
      if (stripComment(content).trim() === '') {
        index += 1;
        result.push(value('', indent));
      } else if (KEY.test(content)) {
        // "- key: value" opens a mapping whose keys align with "key".
        lines[index] = `${' '.repeat(itemIndent)}${content}`;
        result.push(mapping(itemIndent));
      } else {
        index += 1;
        result.push(scalar(stripComment(content), index - 1));
      }
    }
  }

  function node(indent) {
    const line = peek();
    if (line === null) return null;
    return line.slice(indent).startsWith('- ') ? sequence(indent) : mapping(indent);
  }

  const document = node(0);
  if (peek() !== null) fail(index, 'unparsed trailing content');
  return document;
}

// ---------- GitHub Actions expressions ----------

function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const space = /^\s+/.exec(rest);
    if (space) { index += space[0].length; continue; }
    const string = /^'((?:[^']|'')*)'/.exec(rest);
    if (string) { tokens.push({ type: 'string', value: string[1].replaceAll("''", "'") }); index += string[0].length; continue; }
    const number = /^\d+(?:\.\d+)?/.exec(rest);
    if (number) { tokens.push({ type: 'literal', value: Number(number[0]) }); index += number[0].length; continue; }
    const operator = /^(==|!=|&&|\|\||!|\(|\)|\.|,)/.exec(rest);
    if (operator) { tokens.push({ type: 'op', value: operator[0] }); index += operator[0].length; continue; }
    const identifier = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(rest);
    if (identifier) {
      const word = identifier[0];
      if (word === 'true' || word === 'false' || word === 'null') tokens.push({ type: 'literal', value: word === 'null' ? null : word === 'true' });
      else tokens.push({ type: 'identifier', value: word });
      index += word.length;
      continue;
    }
    throw new SyntaxError(`unsupported expression syntax at: ${rest}`);
  }
  return tokens;
}

const truthy = (value) => !(value === false || value === null || value === undefined || value === 0 || value === '' || Number.isNaN(value));
const text = (value) => (value === null || value === undefined ? '' : String(value));

// GitHub compares strings case-insensitively; other types strictly here.
function equal(left, right) {
  if (typeof left === 'string' && typeof right === 'string') return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

const FUNCTIONS = {
  format: (template, ...args) => text(template).replace(/\{(\d+)\}/g, (_, n) => text(args[Number(n)])),
  contains: (haystack, needle) => text(haystack).toLowerCase().includes(text(needle).toLowerCase()),
  startsWith: (value, prefix) => text(value).toLowerCase().startsWith(text(prefix).toLowerCase()),
  endsWith: (value, suffix) => text(value).toLowerCase().endsWith(text(suffix).toLowerCase()),
};

/** Evaluate one expression (the inside of ${{ }}) against a context such as { github, inputs }. */
export function evaluateExpression(source, context) {
  const tokens = tokenize(source);
  let position = 0;
  const peekToken = () => tokens[position];
  const take = (value) => {
    const token = tokens[position];
    if (!token || (value !== undefined && token.value !== value)) throw new SyntaxError(`expected ${value ?? 'a token'} in: ${source}`);
    position += 1;
    return token;
  };

  function primary() {
    const token = take();
    if (token.type === 'literal' || token.type === 'string') return token.value;
    if (token.type === 'op' && token.value === '(') {
      const inner = or();
      take(')');
      return inner;
    }
    if (token.type === 'op' && token.value === '!') return !truthy(primary());
    if (token.type !== 'identifier') throw new SyntaxError(`unexpected ${token.value} in: ${source}`);
    if (peekToken()?.value === '(') {
      const fn = FUNCTIONS[token.value];
      if (!fn) throw new SyntaxError(`unsupported function ${token.value}`);
      take('(');
      const args = [];
      if (peekToken()?.value !== ')') {
        args.push(or());
        while (peekToken()?.value === ',') { take(','); args.push(or()); }
      }
      take(')');
      return fn(...args);
    }
    if (!Object.hasOwn(context, token.value)) throw new SyntaxError(`context ${token.value} is not provided`);
    let current = context[token.value];
    while (peekToken()?.value === '.') {
      take('.');
      const property = take();
      if (property.type !== 'identifier') throw new SyntaxError(`bad property access in: ${source}`);
      current = current !== null && typeof current === 'object' && Object.hasOwn(current, property.value) ? current[property.value] : null;
    }
    return current;
  }

  function comparison() {
    let left = primary();
    while (peekToken()?.value === '==' || peekToken()?.value === '!=') {
      const operator = take().value;
      const right = primary();
      left = operator === '==' ? equal(left, right) : !equal(left, right);
    }
    return left;
  }

  function and() {
    let left = comparison();
    while (peekToken()?.value === '&&') {
      take('&&');
      const right = comparison();
      left = truthy(left) ? right : left;
    }
    return left;
  }

  function or() {
    let left = and();
    while (peekToken()?.value === '||') {
      take('||');
      const right = and();
      left = truthy(left) ? left : right;
    }
    return left;
  }

  const result = or();
  if (position !== tokens.length) throw new SyntaxError(`trailing tokens in: ${source}`);
  return result;
}

/**
 * A workflow value after expression substitution: a value that is exactly one
 * ${{ }} keeps the expression's type; otherwise every expression is
 * interpolated as text. Non-string values are returned unchanged.
 */
export function evaluateWorkflowValue(value, context) {
  if (typeof value !== 'string') return value;
  const whole = /^\$\{\{([\s\S]*)\}\}$/.exec(value.trim());
  if (whole && !whole[1].includes('}}')) return evaluateExpression(whole[1], context);
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) => text(evaluateExpression(expression, context)));
}
