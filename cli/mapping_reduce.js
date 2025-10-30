#!/usr/bin/env node
// mapping_reduce — reduce a conversation mapping to a minimal messages array
import fs from 'node:fs';
import path from 'node:path';
import { reduceMappingToMessages } from '../lib/gpt.js';
import { streamConversations } from '../lib/conversation_stream.js';

function usage() {
  process.stderr.write('Usage:\n');
  process.stderr.write('  node cli/mapping_reduce.js conversations.json [index] > messages.json\n');
  process.stderr.write(
    '  node cli/mapping_reduce.js mapping.json [current_node_id] > messages.json\n',
  );
  process.exit(1);
}

function parseIndex(arg) {
  if (arg === undefined) return 0;
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 0) {
    process.stderr.write('Invalid conversation index\n');
    process.exit(1);
  }
  return n;
}

async function loadFromConversations(file, index) {
  let currentIndex = 0;
  for await (const convo of streamConversations(file)) {
    if (currentIndex === index) {
      if (!convo || typeof convo !== 'object') break;
      const mapping = convo.mapping || {};
      const current = convo.current_node;
      return { mapping, current };
    }
    currentIndex += 1;
  }
  throw new Error('Conversation index out of range');
}

function loadJsonSmall(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text);
  } catch (e) {
    process.stderr.write(`Failed to read JSON: ${String((e && e.message) || e)}\n`);
    process.exit(1);
  }
}

async function main() {
  const file = process.argv[2];
  if (!file) usage();
  const arg2 = process.argv[3];

  const resolved = path.resolve(file);
  let result;
  try {
    result = await loadFromConversations(resolved, parseIndex(arg2));
  } catch (e) {
    const data = loadJsonSmall(resolved);
    let mapping, current;
    if (Array.isArray(data)) {
      const idx = parseIndex(arg2);
      const convo = data[idx];
      if (!convo || typeof convo !== 'object') {
        process.stderr.write('Invalid conversation index\n');
        process.exit(1);
      }
      mapping = convo.mapping || {};
      current = convo.current_node || undefined;
    } else if (data && typeof data === 'object') {
      if (data.mapping) {
        mapping = data.mapping;
        current = data.current_node || arg2;
      } else {
        mapping = data;
        current = arg2;
      }
    } else {
      process.stderr.write('Unrecognized JSON shape\n');
      process.exit(1);
    }
    const messages = reduceMappingToMessages(mapping, { currentNodeId: current });
    process.stdout.write(JSON.stringify(messages, null, 2));
    return;
  }

  const messages = reduceMappingToMessages(result.mapping, { currentNodeId: result.current });
  process.stdout.write(JSON.stringify(messages, null, 2));
}

main().catch(err => {
  process.stderr.write(`Failed: ${String((err && err.message) || err)}\n`);
  process.exit(1);
});
