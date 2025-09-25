#!/usr/bin/env node
// zipread — print the content of a single ZIP entry as UTF-8 text
import { readEntryText } from '../lib/zip.js';

async function main() {
  const zipPath = process.argv[2];
  const entryName = process.argv[3];
  if (!zipPath || !entryName) {
    process.stderr.write('Usage: zipread <archive.zip> <entry/name>\n');
    process.exit(1);
  }
  try {
    const text = await readEntryText(zipPath, entryName);
    process.stdout.write(text);
  } catch (e) {
    process.stderr.write('ERR: ' + String(e && e.message || e) + '\n');
    process.exit(1);
  }
}

main();

