#!/usr/bin/env node
// JSON Tree Viewer (terminal-kit)
// Usage:
//   node cli/jsontree.js file.json
//   cat file.json | node cli/jsontree.js
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { stdin as input, stderr as err } from 'node:process';
import { ensureCursorOnExit } from '../lib/terminal.js';
import { collectConversations } from '../lib/conversation_stream.js';

const require = createRequire(import.meta.url);
let termkit;
try {
  termkit = require('terminal-kit');
} catch {
  err.write('{"type":"ERR_DEP_MISSING","message":"missing dependency: terminal-kit"}\n');
  process.exit(1);
}
const term = termkit.terminal;

function emitError(type, message, hint) {
  try {
    err.write(JSON.stringify({ type, message, hint }) + '\n');
  } catch {
    err.write('{"type":"' + type + '","message":' + JSON.stringify(message) + '}\n');
  }
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    input.setEncoding('utf8');
    input.on('data', c => (data += c));
    input.on('end', () => resolve(data));
    input.on('error', reject);
  });
}

async function loadJsonValue() {
  const p = process.argv[2];
  if (p && p !== '-') {
    const resolved = path.resolve(p);
    const lower = resolved.toLowerCase();
    if (lower.endsWith('.zip')) {
      try {
        return await collectConversations(resolved);
      } catch (e) {
        emitError('ERR_READ', 'cannot read file', String((e && e.message) || e));
        process.exit(1);
      }
    }
    try {
      const text = fs.readFileSync(resolved, 'utf8');
      return JSON.parse(text);
    } catch (e) {
      const message = String((e && e.message) || e);
      if (message.includes('Cannot create a string longer') || lower.endsWith('conversations.json')) {
        try {
          return await collectConversations(resolved);
        } catch (inner) {
          emitError('ERR_READ', 'cannot read file', String((inner && inner.message) || inner));
          process.exit(1);
        }
      }
      emitError('ERR_READ', 'cannot read file', message);
      process.exit(1);
    }
  }
  try {
    const text = await readStdin();
    return JSON.parse(text);
  } catch (e) {
    emitError('ERR_STDIN', 'failed to read stdin', String((e && e.message) || e));
    process.exit(1);
  }
}

function typeOf(v) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'object') return Array.isArray(v) ? 'array' : 'object';
  return t; // string | number | boolean
}

function previewValue(v, max = 60) {
  const t = typeOf(v);
  switch (t) {
    case 'string': {
      const s = v.length > max ? v.slice(0, max - 1) + '…' : v;
      return '"' + s.replace(/\n/g, '⏎') + '"';
    }
    case 'number':
      return String(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'array':
      return '[' + v.length + ']';
    case 'object':
      return '{' + Object.keys(v).length + '}';
    default:
      return String(v);
  }
}

function makeNode({ key, value, depth = 0, path = [], parent = null }) {
  const t = typeOf(value);
  const hasChildren =
    (t === 'object' && value && Object.keys(value).length) ||
    (t === 'array' && value && value.length);
  const node = {
    key,
    value,
    type: t,
    depth,
    path,
    parent,
    expanded: depth === 0, // root expanded
    _childrenBuilt: false,
    children: null,
    buildChildren() {
      if (this._childrenBuilt) return;
      this._childrenBuilt = true;
      if (this.type === 'object') {
        const keys = Object.keys(this.value);
        this.children = keys.map(k =>
          makeNode({
            key: k,
            value: this.value[k],
            depth: this.depth + 1,
            path: this.path.concat([k]),
            parent: this,
          }),
        );
      } else if (this.type === 'array') {
        this.children = this.value.map((v, i) =>
          makeNode({
            key: i,
            value: v,
            depth: this.depth + 1,
            path: this.path.concat([i]),
            parent: this,
          }),
        );
      } else {
        this.children = [];
      }
    },
    hasChildren: !!hasChildren,
  };
  return node;
}

function collectVisible(node, out) {
  out.push(node);
  if (!node.hasChildren) return;
  if (!node.expanded) return;
  if (!node._childrenBuilt) node.buildChildren();
  for (const c of node.children) collectVisible(c, out);
}

function labelFor(node) {
  const t = node.type;
  const keyLabel =
    node.key === undefined || node.key === null
      ? '(root)'
      : typeof node.key === 'number'
        ? `[${node.key}]`
        : String(node.key);
  let valueLabel = '';
  if (t === 'object') valueLabel = previewValue(node.value);
  else if (t === 'array') valueLabel = previewValue(node.value);
  else valueLabel = previewValue(node.value);
  return { keyLabel, valueLabel };
}

function drawLine(node, isSelected, width) {
  const indent = '  '.repeat(node.depth);
  const caret = node.hasChildren ? (node.expanded ? '▾' : '▸') : ' ';
  const { keyLabel, valueLabel } = labelFor(node);
  // Compose line with color
  let line = indent + caret + ' ';
  // key
  line += keyLabel + ': ';
  // value preview with type color
  let valStr = valueLabel;
  // trim to width
  if (line.length + valStr.length > width) {
    valStr = valStr.slice(0, Math.max(0, width - line.length - 1)) + '…';
  }
  if (isSelected) {
    term.black.bgWhite(line + valStr);
  } else {
    // simple coloring by type
    const t = node.type;
    term(line);
    if (t === 'string') term.green(valStr);
    else if (t === 'number') term.yellow(valStr);
    else if (t === 'boolean') term.magenta(valStr);
    else if (t === 'null') term.gray(valStr);
    else term.white(valStr);
  }
}

function pathEquals(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function findIndexByPath(visible, path) {
  for (let i = 0; i < visible.length; i++) if (pathEquals(visible[i].path, path)) return i;
  return 0;
}

async function main() {
  // hide cursor (toggle API per terminal-kit) and grab input for key events
  term.hideCursor();
  term.grabInput(true);
  const rootVal = await loadJsonValue();

  const root = makeNode({ key: null, value: rootVal, depth: 0, path: [], parent: null });
  let visible = [];
  collectVisible(root, visible);
  let cursorIdx = 0;
  let scroll = 0;

  const top = 1; // start row
  const height = Math.max(5, term.height - 2);
  const width = term.width - 1;

  function clampState() {
    if (cursorIdx < 0) cursorIdx = 0;
    if (cursorIdx >= visible.length) cursorIdx = Math.max(0, visible.length - 1);
    if (cursorIdx < scroll) scroll = cursorIdx;
    if (cursorIdx >= scroll + height) scroll = cursorIdx - height + 1;
    if (scroll < 0) scroll = 0;
    const maxScroll = Math.max(0, visible.length - height);
    if (scroll > maxScroll) scroll = maxScroll;
  }

  function render() {
    term.moveTo(1, 1);
    for (let row = 0; row < height; row++) {
      term.moveTo(1, top + row);
      term.eraseLine();
      const idx = scroll + row;
      if (idx < visible.length) {
        drawLine(visible[idx], idx === cursorIdx, width);
      }
    }
    // status line
    term.moveTo(1, top + height);
    term.eraseLine();
    const node = visible[cursorIdx];
    const p = node
      ? node.path.length
        ? node.path.map(x => (typeof x === 'number' ? `[${x}]` : String(x))).join('.')
        : '(root)'
      : '';
    term.gray(
      `path: ${p}  type: ${node ? node.type : ''}   q=quit  arrows or h/j/k/l move  g/G top/bottom  u/d page  Enter/Space toggle`,
    );
  }

  function rebuildVisibleAndKeepCursor(path) {
    const oldPath = path ?? (visible[cursorIdx] ? visible[cursorIdx].path : []);
    visible = [];
    collectVisible(root, visible);
    cursorIdx = findIndexByPath(visible, oldPath);
    clampState();
  }

  render();

  const onKey = key => {
    switch (key) {
      case 'q':
      case 'Q':
        term.clear();
        term.grabInput(false);
        term.hideCursor(); // toggle back to show
        process.exit(0);
        break;
      case 'UP':
      case 'k':
      case 'K':
        cursorIdx--;
        clampState();
        render();
        break;
      case 'DOWN':
      case 'j':
      case 'J':
        cursorIdx++;
        clampState();
        render();
        break;
      case 'LEFT':
      case 'h':
      case 'H': {
        const n = visible[cursorIdx];
        if (!n) break;
        if (n.hasChildren && n.expanded) {
          n.expanded = false;
          rebuildVisibleAndKeepCursor(n.path);
          render();
        } else if (n.parent) {
          // move to parent
          const parentPath = n.parent.path;
          rebuildVisibleAndKeepCursor(parentPath);
          render();
        }
        break;
      }
      case 'RIGHT':
      case 'l':
      case 'L':
      case 'ENTER':
      case ' ': {
        const n = visible[cursorIdx];
        if (!n) break;
        if (n.hasChildren) {
          if (!n._childrenBuilt) n.buildChildren();
          n.expanded = !n.expanded;
          rebuildVisibleAndKeepCursor(n.path);
          render();
        }
        break;
      }
      case 'HOME':
      case 'g':
        cursorIdx = 0;
        clampState();
        render();
        break;
      case 'END':
      case 'G':
        cursorIdx = visible.length - 1;
        clampState();
        render();
        break;
      case 'PAGE_UP':
      case 'u':
      case 'CTRL_U':
        cursorIdx -= height;
        clampState();
        render();
        break;
      case 'PAGE_DOWN':
      case 'd':
      case 'CTRL_D':
        cursorIdx += height;
        clampState();
        render();
        break;
      default:
        break;
    }
  };

  term.on('key', onKey);
}

main().catch(err => {
  emitError('ERR_RUNTIME', 'unexpected error', String((err && err.message) || err));
  process.exit(1);
});
ensureCursorOnExit();
