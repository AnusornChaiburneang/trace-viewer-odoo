// Preserve the source consumed by this run independently of the saved-flow library.
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { createHash } = require('crypto');

function createCapture(filename, stdin = process.stdin) {
  let content = filename ? fs.readFileSync(filename, 'utf8') : '';
  let complete = Boolean(filename);
  const input = filename ? Readable.from([content]) : stdin;
  const mode = filename ? 'file' : stdin.isTTY ? 'interactive' : 'stdin';
  return {
    input,
    start() {
      if (filename) return;
      input.setEncoding('utf8');
      input.on('data', chunk => { content += chunk; });
      input.on('end', () => { complete = true; });
    },
    snapshot() {
      return {
        sha256: createHash('sha256').update(content).digest('hex'),
        content: content.replace(/^(\s*)(login|cookie)[ \t]+[^\r\n]*/gm, '$1$2 [redacted]'),
        credentials_redacted: true, capture: mode, complete,
        source_path: filename ? path.resolve(filename) : null,
      };
    },
  };
}
module.exports = { createCapture };
