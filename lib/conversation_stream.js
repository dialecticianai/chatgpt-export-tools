// Helpers to stream ChatGPT export conversations without creating huge strings.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import unzipper from 'unzipper';
import streamJson from 'stream-json';
import PickModule from 'stream-json/filters/Pick.js';
import StreamArrayModule from 'stream-json/streamers/StreamArray.js';

const { parser } = streamJson;
const pick = PickModule.pick ?? PickModule;
const streamArray = StreamArrayModule.streamArray ?? StreamArrayModule;

const CONVERSATIONS_FILENAME = 'conversations.json';

async function resolveInput(inputPath) {
  if (!inputPath) throw new Error('No input path provided');
  const resolved = path.resolve(inputPath);
  const lower = resolved.toLowerCase();
  if (lower.endsWith('.zip')) {
    return {
      kind: 'zip',
      sourcePath: resolved,
      async openStream() {
        const directory = await unzipper.Open.file(resolved);
        // Prefer exact match first, then fallback to case-insensitive search.
        let entry = directory.files.find(f => f.path === CONVERSATIONS_FILENAME);
        if (!entry) entry = directory.files.find(f => path.basename(f.path) === CONVERSATIONS_FILENAME);
        if (!entry) {
          await directory.close();
          throw new Error(`${CONVERSATIONS_FILENAME} not found inside ${resolved}`);
        }
        const stream = entry.stream();
        const close = () => {
          stream.removeListener('end', close);
          stream.removeListener('error', close);
          stream.removeListener('close', close);
          if (typeof directory.close === 'function') {
            directory.close().catch(() => {});
          }
        };
        stream.on('end', close);
        stream.on('error', close);
        stream.on('close', close);
        return stream;
      },
    };
  }

  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch (err) {
    throw new Error(`Input path not found: ${resolved}`);
  }

  const jsonPath = stat.isDirectory() ? path.join(resolved, CONVERSATIONS_FILENAME) : resolved;
  try {
    await fsp.access(jsonPath, fs.constants.R_OK);
  } catch {
    throw new Error(`Unable to read ${jsonPath}`);
  }

  return {
    kind: stat.isDirectory() ? 'directory' : 'file',
    sourcePath: jsonPath,
    async openStream() {
      return fs.createReadStream(jsonPath);
    },
  };
}

async function* parseConversationsStream(stream, { wrapper }) {
  let pipeline = stream.pipe(parser());
  if (wrapper) {
    pipeline = pipeline.pipe(pick({ filter: 'conversations' }));
  }
  const arrayStream = pipeline.pipe(streamArray());
  for await (const chunk of arrayStream) {
    yield chunk.value;
  }
}

export async function* streamConversations(inputPath) {
  const input = await resolveInput(inputPath);

  let yielded = 0;
  // First assume modern wrapper shape: { conversations: [...] }
  try {
    const s = await input.openStream();
    try {
      for await (const convo of parseConversationsStream(s, { wrapper: true })) {
        yielded += 1;
        yield convo;
      }
      if (yielded > 0) return;
    } finally {
      s.destroy?.();
    }
  } catch (err) {
    // If wrapper attempt threw because of missing node, fall back to plain array.
    if (yielded === 0) {
      // swallow and try plain mode below
    } else {
      throw err;
    }
  }

  const fallbackStream = await input.openStream();
  try {
    for await (const convo of parseConversationsStream(fallbackStream, { wrapper: false })) {
      yield convo;
    }
  } finally {
    fallbackStream.destroy?.();
  }
}

export async function collectConversations(inputPath) {
  const result = [];
  for await (const convo of streamConversations(inputPath)) {
    result.push(convo);
  }
  return result;
}
