#!/usr/bin/env node
// convo_query — stream-friendly matcher/stats CLI for ChatGPT exports
import process from 'node:process';
import path from 'node:path';
import { streamConversations } from '../lib/conversation_stream.js';
import { reduceMappingToMessages } from '../lib/gpt.js';

function usage() {
  const script = path.basename(process.argv[1] || 'convo_query.js');
  const lines = [
    `Usage: ${script} <export path> [options]`,
    '',
    'Options:',
    '  --title <regex>        Filter conversations whose title matches regex',
    '  --message <regex>      Filter messages whose text matches regex',
    '  --author a,b           Restrict messages to comma-separated author list (user,assistant,system,tool)',
    '  --mode matches|stats   Emit per-match records (default) or aggregate stats only',
    '  --limit N              Stop after emitting N matches (matches mode)',
    '  --case-sensitive       Make title/message regexes case-sensitive',
    '  --format ndjson|json   Output format for matches (default ndjson)',
    '  --stats                Emit processing summary as JSON to stderr (matches mode)',
  ];
  process.stderr.write(lines.join('\n') + '\n');
}

function exitWith(message) {
  process.stderr.write(message + '\n');
  usage();
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    input: null,
    mode: 'matches',
    titlePattern: null,
    messagePattern: null,
    authorFilter: null,
    caseSensitive: false,
    limit: Infinity,
    format: 'ndjson',
    includeStats: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mode') {
      const val = argv[++i];
      if (!val || !['matches', 'stats'].includes(val)) exitWith('Invalid --mode value');
      opts.mode = val;
    } else if (arg === '--title') {
      const val = argv[++i];
      if (!val) exitWith('Missing value for --title');
      opts.titlePattern = val;
    } else if (arg === '--message') {
      const val = argv[++i];
      if (!val) exitWith('Missing value for --message');
      opts.messagePattern = val;
    } else if (arg === '--author') {
      const val = argv[++i];
      if (!val) exitWith('Missing value for --author');
      const authors = val
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
      if (!authors.length) exitWith('Author list empty');
      opts.authorFilter = new Set(authors);
    } else if (arg === '--case-sensitive') {
      opts.caseSensitive = true;
    } else if (arg === '--limit') {
      const val = argv[++i];
      const num = Number(val);
      if (!Number.isFinite(num) || num <= 0) exitWith('Invalid --limit value');
      opts.limit = num;
    } else if (arg === '--format') {
      const val = argv[++i];
      if (!val || !['ndjson', 'json'].includes(val)) exitWith('Invalid --format value');
      opts.format = val;
    } else if (arg === '--stats') {
      opts.includeStats = true;
    } else if (arg.startsWith('-')) {
      exitWith(`Unknown option ${arg}`);
    } else {
      rest.push(arg);
    }
  }
  if (rest.length) opts.input = rest[0];
  return opts;
}

function buildRegex(pattern, caseSensitive) {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, caseSensitive ? 'g' : 'gi');
  } catch (err) {
    exitWith(`Invalid regex: ${String((err && err.message) || err)}`);
  }
}

function countLines(text) {
  const str = String(text ?? '');
  if (!str) return 0;
  return str.split(/\r?\n/).length;
}

function countWords(text) {
  const str = String(text ?? '').trim();
  if (!str) return 0;
  return str.split(/\s+/).length;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) exitWith('Missing export path');

  const titleRegex = buildRegex(options.titlePattern, options.caseSensitive);
  const messageRegex = buildRegex(options.messagePattern, options.caseSensitive);

  const totals = {
    conversations: 0,
    messages: 0,
    lines: 0,
    words: 0,
    authors: Object.create(null),
  };
  const matchStats = {
    conversationsTitle: 0,
    conversationsMessages: 0,
    messageMatches: 0,
  };
  const matchedByTitle = new Set();
  const matchedByMessage = new Set();

  let matchCount = 0;
  const outputBuffer = [];

  let conversationIndex = 0;
  for await (const convo of streamConversations(options.input)) {
    const conversation = convo || {};
    const title = conversation.title || '';
    totals.conversations += 1;

    const mapping = conversation.mapping || {};
    const messages = reduceMappingToMessages(mapping, { currentNodeId: conversation.current_node });
    totals.messages += messages.length;

    let titleMatched = true;
    if (titleRegex) {
      titleMatched = titleRegex.test(title);
      titleRegex.lastIndex = 0;
      if (titleMatched) matchedByTitle.add(conversationIndex);
    }

    const conversationId = conversation.conversation_id || conversation.id || null;
    let conversationHadMessageMatch = false;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const author = msg.author || 'unknown';
      totals.authors[author] = (totals.authors[author] || 0) + 1;
      totals.lines += countLines(msg.text);
      totals.words += countWords(msg.text);

      const authorOk = options.authorFilter ? options.authorFilter.has(author) : true;
      if (!authorOk) continue;

      let messageMatched = false;
      if (messageRegex) {
        messageMatched = messageRegex.test(msg.text || '');
        messageRegex.lastIndex = 0;
      } else if (titleRegex) {
        messageMatched = titleMatched;
      }

      if (options.mode === 'matches' && titleMatched && messageMatched) {
        conversationHadMessageMatch = true;
        matchedByMessage.add(conversationIndex);
        matchStats.messageMatches += 1;
        const payload = {
          type: 'message',
          conversation_index: conversationIndex,
          conversation_id: conversationId,
          title,
          message_index: i,
          author,
          text: msg.text || '',
        };
        if (options.format === 'ndjson') {
          process.stdout.write(JSON.stringify(payload) + '\n');
        } else {
          outputBuffer.push(payload);
        }
        matchCount += 1;
        if (matchCount >= options.limit) break;
      }
    }

    if (
      options.mode === 'matches' &&
      !messageRegex &&
      titleMatched &&
      matchCount < options.limit &&
      !conversationHadMessageMatch
    ) {
      const payload = {
        type: 'conversation',
        conversation_index: conversationIndex,
        conversation_id: conversationId,
        title,
      };
      if (options.format === 'ndjson') process.stdout.write(JSON.stringify(payload) + '\n');
      else outputBuffer.push(payload);
      matchCount += 1;
      matchedByTitle.add(conversationIndex);
    }

    if (matchCount >= options.limit) break;
    conversationIndex += 1;
  }

  matchStats.conversationsTitle = matchedByTitle.size;
  matchStats.conversationsMessages = matchedByMessage.size;

  if (options.mode === 'stats') {
    const stats = {
      totals: {
        conversations: totals.conversations,
        messages: totals.messages,
        lines: totals.lines,
        words: totals.words,
      },
      authors: totals.authors,
      matches: {
        conversations_title: matchStats.conversationsTitle,
        conversations_messages: matchStats.conversationsMessages,
        message_matches: matchStats.messageMatches,
      },
      averages: {
        messages_per_conversation: totals.conversations
          ? totals.messages / totals.conversations
          : 0,
        lines_per_message: totals.messages ? totals.lines / totals.messages : 0,
        words_per_message: totals.messages ? totals.words / totals.messages : 0,
      },
    };
    process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
    return;
  }

  if (options.format === 'json') {
    process.stdout.write(JSON.stringify(outputBuffer, null, 2) + '\n');
  }

  if (options.includeStats) {
    const summary = {
      conversations_processed: totals.conversations,
      messages_processed: totals.messages,
      matches_emitted: matchCount,
      unique_conversations_title: matchStats.conversationsTitle,
      unique_conversations_message: matchStats.conversationsMessages,
    };
    process.stderr.write(JSON.stringify(summary) + '\n');
  }
}

main().catch(err => {
  process.stderr.write(String((err && err.stack) || err) + '\n');
  process.exit(1);
});
