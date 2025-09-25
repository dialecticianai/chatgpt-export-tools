#!/usr/bin/env node
// analyze_export — compute basic metrics from a ChatGPT conversations.json
import fs from 'node:fs';
import path from 'node:path';
import { reduceMappingToMessages } from '../lib/gpt.js';

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

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function computeSummaryFromData(data, file) {
  if (!Array.isArray(data)) throw new Error('JSON root is not an array of conversations');
  const totalConversations = data.length;
  let totalMessages = 0;
  let totalLines = 0;
  let totalWords = 0;
  const perConversation = [];
  for (let i = 0; i < data.length; i++) {
    const convo = data[i] || {};
    const mapping = convo.mapping || {};
    const current = convo.current_node;
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
    perConversation.push({ index: i, title: convo.title || `Conversation #${i + 1}`, messages: mCount, lines: lCount, words: wCount });
  }
  const avg = (a, b) => (b > 0 ? a / b : 0);
  const summary = {
    file,
    total_conversations: totalConversations,
    total_messages: totalMessages,
    total_lines: totalLines,
    total_words: totalWords,
    avg_messages_per_conversation: avg(totalMessages, totalConversations),
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

function main() {
  const file = process.argv[2] || path.resolve('backup1/conversations.json');
  const diffFlagIndex = process.argv.indexOf('--diff');
  const hasDiff = diffFlagIndex !== -1 && process.argv[diffFlagIndex + 1];
  let newerData, olderData;
  try {
    newerData = readJson(file);
  } catch (e) {
    console.error(JSON.stringify({ type: 'ERR_READ', message: 'Failed to read/parse newer JSON', hint: String(e && e.message || e), file }));
    process.exit(1);
  }
  let newer;
  try {
    const r = computeSummaryFromData(newerData, file);
    newer = r.summary;
    // For the non-diff path we will output perConversation as well
    if (!hasDiff) {
      process.stdout.write(JSON.stringify({ summary: newer, per_conversation: r.perConversation }) + '\n');
      return;
    }
    olderData = readJson(process.argv[diffFlagIndex + 1]);
  } catch (e) {
    console.error(JSON.stringify({ type: 'ERR_SHAPE', message: String(e && e.message || e) }));
    process.exit(1);
  }
  let older;
  try {
    older = computeSummaryFromData(olderData, process.argv[diffFlagIndex + 1]).summary;
  } catch (e) {
    console.error(JSON.stringify({ type: 'ERR_SHAPE', message: 'Older JSON invalid', hint: String(e && e.message || e) }));
    process.exit(1);
  }
  const diff = diffSummaries(newer, older);
  process.stdout.write(JSON.stringify({ newer_summary: newer, older_summary: older, diff_summary: diff }) + '\n');
}

main();
