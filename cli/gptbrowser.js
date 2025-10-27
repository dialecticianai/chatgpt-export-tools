#!/usr/bin/env node
// gptbrowser — specialized viewer for ChatGPT export ZIPs
import {
  term,
  ensureCursorOnExit,
  statusKeys,
  statusSearch,
  listMenu,
  terminalEnter,
  terminalLeave,
  status,
  printHighlighted,
  wrapLines,
} from '../lib/terminal.js';
import { emitError } from '../lib/io.js';
import { reduceMappingToMessages, exportConversationPlain } from '../lib/gpt.js';
import { collectConversations } from '../lib/conversation_stream.js';

ensureCursorOnExit();

// wrapLines extracted to lib helpers

async function presentMessages(messages, title) {
  // Single large scrollable text panel composed of wrapped messages
  terminalEnter();
  term.clear();
  const contentTop = 2;
  const height = Math.max(5, term.height - 2); // content area height
  const width = term.width - 2;
  const header = String(title || '').slice(0, width);

  // Build wrapped lines and message offsets
  const lines = [];
  const msgOffsets = [];
  const colorFor = who => (who === 'user' ? 'cyan' : who === 'assistant' ? 'magenta' : null);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    msgOffsets.push(lines.length);
    const who = m.author || 'unknown';
    const color = colorFor(who);
    lines.push({ text: `[${who}]`, color });
    const wrapped = wrapLines(m.text || '', width);
    for (const w of wrapped) lines.push({ text: w, color });
    lines.push({ text: '', color: 'gray' }); // separator
  }

  let cursor = 0;
  let lastQuery = '';
  let inSearch = false;
  let searchBuffer = '';
  const clamp = () => {
    const maxScroll = Math.max(0, lines.length - (term.height - 2));
    if (cursor < 0) cursor = 0;
    if (cursor > maxScroll) cursor = maxScroll;
  };
  const jumpNextMsg = () => {
    for (let i = 0; i < msgOffsets.length; i++) {
      if (msgOffsets[i] > cursor) {
        cursor = msgOffsets[i];
        return;
      }
    }
    cursor = lines.length;
    clamp();
  };
  const jumpPrevMsg = () => {
    for (let i = msgOffsets.length - 1; i >= 0; i--) {
      if (msgOffsets[i] < cursor) {
        cursor = msgOffsets[i];
        return;
      }
    }
    cursor = 0;
  };

  const render = () => {
    term.moveTo(1, 1);
    term.eraseLine();
    term.white(header);
    for (let row = 0; row < height; row++) {
      term.moveTo(1, contentTop + row);
      term.eraseLine();
      const idx = cursor + row;
      if (idx < lines.length) {
        const line = lines[idx];
        const text = typeof line === 'string' ? line : line.text;
        const color = typeof line === 'string' ? null : line.color;
        const q = inSearch ? searchBuffer : lastQuery;
        const base = color && typeof term[color] === 'function' ? term[color] : term;
        printHighlighted(text, { base, query: q, highlightBg: 'bgYellow' });
      }
    }
    if (inSearch) statusSearch('Search', searchBuffer || '');
    else
      statusKeys([
        'q=back',
        'e=export',
        '/ find',
        'n/N next/prev match',
        ']/[ next/prev msg',
        'u/d page',
        'g/G top/bottom',
      ]);
  };

  clamp();
  render();
  await new Promise(resolve => {
    const onKey = async key => {
      // If searching, capture keys into the query buffer and perform live search
      if (inSearch) {
        if (key === 'ESCAPE') {
          inSearch = false;
          render();
          return;
        }
        if (key === 'BACKSPACE') {
          searchBuffer = searchBuffer.slice(0, -1);
          render();
          return;
        }
        if (key === 'ENTER' || key === 'KP_ENTER') {
          lastQuery = searchBuffer;
          inSearch = false;
          render();
          return;
        }
        if (key.length === 1 && key >= ' ' && key <= '~') {
          searchBuffer += key;
        }
        const q = searchBuffer.toLowerCase();
        if (!q) {
          render();
          return;
        }
        let found = -1;
        const from = cursor + 1;
        for (let i = from; i < lines.length; i++) {
          const t = typeof lines[i] === 'string' ? lines[i] : lines[i].text;
          if (t && t.toLowerCase().includes(q)) {
            found = i;
            break;
          }
        }
        if (found < 0) {
          for (let i = 0; i < from; i++) {
            const t = typeof lines[i] === 'string' ? lines[i] : lines[i].text;
            if (t && t.toLowerCase().includes(q)) {
              found = i;
              break;
            }
          }
        }
        if (found >= 0) {
          cursor = found;
          clamp();
          render();
        } else {
          statusSearch('Search', searchBuffer, {
            error: true,
            hint: '(no matches, ESC to cancel)',
          });
        }
        return;
      }
      switch (key) {
        case 'q':
        case 'Q':
          term.off('key', onKey);
          return resolve();
        case 'UP':
        case 'k':
        case 'K':
          cursor -= 1;
          clamp();
          return render();
        case 'DOWN':
        case 'j':
        case 'J':
          cursor += 1;
          clamp();
          return render();
        case 'PAGE_UP':
        case 'u':
        case 'CTRL_U':
          cursor -= height;
          clamp();
          return render();
        case 'PAGE_DOWN':
        case 'd':
        case 'CTRL_D':
          cursor += height;
          clamp();
          return render();
        case 'HOME':
        case 'g':
          cursor = 0;
          clamp();
          return render();
        case 'END':
        case 'G':
          cursor = 1e9;
          clamp();
          return render();
        case ']':
          jumpNextMsg();
          clamp();
          return render();
        case '[':
          jumpPrevMsg();
          clamp();
          return render();
        case 'e':
        case 'E':
          exportConversationPlain(title, messages)
            .then(p => status('Exported ' + p, 'green'))
            .catch(e => status('Export failed: ' + String((e && e.message) || e), 'red'));
          return; // stay in viewer
        case '/':
          inSearch = true;
          searchBuffer = '';
          render();
          return;
        case 'n':
        case 'N': {
          if (!lastQuery) return; // nothing to repeat
          const q = lastQuery.toLowerCase();
          const dir = key === 'n' ? 1 : -1;
          let i = cursor + dir;
          for (let steps = 0; steps < lines.length; steps++, i += dir) {
            if (i < 0) i = lines.length - 1;
            if (i >= lines.length) i = 0;
            const t = typeof lines[i] === 'string' ? lines[i] : lines[i].text;
            if (t && t.toLowerCase().includes(q)) {
              cursor = i;
              clamp();
              render();
              return;
            }
          }
          status('No match', 'red');
          return;
        }
      }
    };
    term.on('key', onKey);
  });
}

async function main() {
  const zipPath = process.argv[2];
  terminalEnter();
  if (!zipPath) {
    emitError('ERR_INPUT', 'missing zip path', 'gptbrowser <file.zip>');
    process.exit(1);
  }

  let conversations;
  try {
    conversations = await collectConversations(zipPath);
  } catch (e) {
    term.red(`Failed to load conversations.json: ${String((e && e.message) || e)}\n`);
    terminalLeave();
    process.exit(1);
  }
  if (!Array.isArray(conversations)) {
    term.red('conversations.json did not contain an array.\n');
    terminalLeave();
    process.exit(1);
  }

  const items = conversations.map((c, i) => ({
    idx: i,
    label: c && c.title ? c.title : `Conversation #${i + 1}`,
  }));

  while (true) {
    term.clear();
    let currentIndex = 0;
    let inSearch = false;
    let searchBuffer = '';
    let lastQuery = '';
    const res = await listMenu(
      items.map(i => i.label),
      {
        x: 1,
        y: 1,
        width: term.width - 2,
        height: Math.max(5, term.height - 2),
        style: term.white,
        selectedStyle: term.black.bgWhite,
        onHighlight: ev => {
          if (ev && typeof ev.highlightedIndex === 'number') currentIndex = ev.highlightedIndex;
          if (!inSearch)
            statusKeys(['q=quit', 'Enter=open', 'e=export', '/ find', 'n/N next/prev']);
        },
        getHighlightQuery: () => (inSearch ? searchBuffer : lastQuery),
        onKey: async key => {
          const labelsLower = items.map(i => i.label.toLowerCase());
          const findFrom = (start, dir, q) => {
            const L = labelsLower.length;
            let idx = start;
            for (let i = 0; i < L; i++) {
              idx = (idx + dir + L) % L;
              if (labelsLower[idx].includes(q)) return idx;
            }
            return -1;
          };
          if (key === '/') {
            inSearch = true;
            searchBuffer = '';
            status('Search: ', 'gray');
            return true;
          }
          if (inSearch) {
            if (key === 'ESCAPE') {
              inSearch = false;
              statusKeys(['q=quit', 'Enter=open', 'e=export', '/ find', 'n/N next/prev']);
              return true;
            }
            if (key === 'BACKSPACE') {
              searchBuffer = searchBuffer.slice(0, -1);
            } else if (key === 'ENTER' || key === 'KP_ENTER') {
              lastQuery = searchBuffer;
              inSearch = false;
              statusKeys(['q=quit', 'Enter=open', 'e=export', '/ find', 'n/N next/prev']);
              return true;
            } else if (key.length === 1 && key >= ' ' && key <= '~') {
              searchBuffer += key;
            }
            // live search
            const q = searchBuffer.toLowerCase();
            if (!q) {
              status('Search: ', 'gray');
              return true;
            }
            const start = currentIndex; // search from current
            const idx = findFrom(start, +1, q);
            if (idx >= 0) {
              status(`Search: ${searchBuffer}`, 'gray');
              return { selectIndex: idx };
            } else {
              status(`Search: ${searchBuffer}  (no matches, ESC to cancel)`, 'red');
              return true;
            }
          }
          if (key === 'e' || key === 'E') {
            const it2 = items[currentIndex];
            if (!it2) return true;
            try {
              const convo = conversations[it2.idx] || {};
              const mapping = convo.mapping || {};
              const current = convo.current_node;
              const messages = reduceMappingToMessages(mapping, { currentNodeId: current });
              const p = await exportConversationPlain(items[it2.idx].label, messages);
              status('Exported ' + p, 'green');
            } catch (e) {
              status('Export failed: ' + String((e && e.message) || e), 'red');
            }
            return true; // handled
          }
          if (key === 'n' || key === 'N') {
            const q = (lastQuery || '').toLowerCase();
            if (!q) return true;
            const dir = key === 'n' ? +1 : -1;
            const idx = findFrom(currentIndex, dir, q);
            if (idx >= 0) return { selectIndex: idx };
            status('No match', 'red');
            return true;
          }
          return false;
        },
      },
    );
    if (res.type !== 'submit') break;
    const it = items[res.index];
    if (!it) continue;
    try {
      // Build a simple messages view from mapping/current_node
      const convo = conversations[it.idx] || {};
      const mapping = convo.mapping || {};
      const current = convo.current_node;
      const messages = reduceMappingToMessages(mapping, { currentNodeId: current });
      await presentMessages(messages, items[it.idx].label);
    } catch (e) {
      term.red(`Open failed: ${String((e && e.message) || e)}\n`);
      await new Promise(r => term.once('key', () => r()));
    }
  }
  terminalLeave();
  process.exit(0);
}

main();
