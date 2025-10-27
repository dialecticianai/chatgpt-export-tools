#!/usr/bin/env node
// analyze_export — compute basic metrics from a ChatGPT conversations.json
import path from 'node:path';
import { reduceMappingToMessages } from '../lib/gpt.js';
import { streamConversations } from '../lib/conversation_stream.js';

function countLines(s) {
  const str = String(s ?? '');
  if (!str) return 0;
  return str.split(/\r?\n/).length;
}

function countWords(s) {
  const str = String(s ?? '').trim();
  if (!str) return 0;
  return str.split(/\s+/).length;
}

async function computeSummaryFromFile(file) {
  let totalMessages = 0;
  let totalLines = 0;
  let totalWords = 0;
  const perConversation = [];
  let index = 0;
  for await (const convo of streamConversations(file)) {
    const i = index;
    index += 1;
    const conversation = convo || {};
    if (typeof conversation !== 'object') continue;
    const mapping = conversation.mapping || {};
    const current = conversation.current_node;
    const messages = reduceMappingToMessages(mapping, { currentNodeId: current });
    let mCount = 0, lCount = 0, wCount = 0;
    for (const m of messages) {
      const text = m && m.text ? m.text : '';
      mCount += 1;
      lCount += countLines(text);
      wCount += countWords(text);
    }
    totalMessages += mCount;
    totalLines += lCount;
    totalWords += wCount;
    perConversation.push({
      index: i,
      title: conversation.title || `Conversation #${i + 1}`,
      messages: mCount,
      lines: lCount,
      words: wCount,
    });
  }
  const avg = (a, b) => (b > 0 ? a / b : 0);
  const summary = {
    file,
    total_conversations: index,
    total_messages: totalMessages,
    total_lines: totalLines,
    total_words: totalWords,
    avg_messages_per_conversation: avg(totalMessages, index),
    avg_lines_per_message: avg(totalLines, totalMessages),
    avg_words_per_message: avg(totalWords, totalMessages),
  };
  return { summary, perConversation };
}

function diffSummaries(newer, older) {
  const diff = (a, b) => a - b;
  const total_conversations = diff(newer.total_conversations, older.total_conversations);
  const total_messages = diff(newer.total_messages, older.total_messages);
  const total_lines = diff(newer.total_lines, older.total_lines);
  const total_words = diff(newer.total_words, older.total_words);
  const avg = (a, b) => (b > 0 ? a / b : 0);
  return {
    mode: 'diff',
    newer_file: newer.file,
    older_file: older.file,
    total_conversations,
    total_messages,
    total_lines,
    total_words,
    avg_messages_per_conversation: avg(total_messages, total_conversations),
    avg_lines_per_message: avg(total_lines, total_messages),
    avg_words_per_message: avg(total_words, total_messages),
  };
}

async function main() {
  const file = process.argv[2] || path.resolve('backup1/conversations.json');
  const diffFlagIndex = process.argv.indexOf('--diff');
  const hasDiff = diffFlagIndex !== -1 && process.argv[diffFlagIndex + 1];

  let newerResult;
  try {
    newerResult = await computeSummaryFromFile(file);
  } catch (e) {
    console.error(
      JSON.stringify({
        type: 'ERR_READ',
        message: 'Failed to read/parse newer JSON',
        hint: String((e && e.message) || e),
        file,
      }),
    );
    process.exit(1);
  }

  const newer = newerResult.summary;
  if (!hasDiff) {
    process.stdout.write(JSON.stringify({ summary: newer, per_conversation: newerResult.perConversation }) + '\n');
    return;
  }

  const olderPath = process.argv[diffFlagIndex + 1];
  let olderSummary;
  try {
    olderSummary = (await computeSummaryFromFile(olderPath)).summary;
  } catch (e) {
    console.error(
      JSON.stringify({
        type: 'ERR_SHAPE',
        message: 'Older JSON invalid',
        hint: String((e && e.message) || e),
      }),
    );
    process.exit(1);
  }

  const diff = diffSummaries(newer, olderSummary);
  process.stdout.write(
    JSON.stringify({ newer_summary: newer, older_summary: olderSummary, diff_summary: diff }) + '\n',
  );
}

main().catch(err => {
  console.error(JSON.stringify({ type: 'ERR_RUNTIME', message: String((err && err.message) || err) }));
  process.exit(1);
});
