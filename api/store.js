// File-based run store: one directory per run under <DATA_DIR>/runs/<id>/.
// run.json never contains credentials — those live only in the worker's memory.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'runs');
    fs.mkdirSync(this.root, { recursive: true });
  }
  dir(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('bad run id');
    return path.join(this.root, id);
  }
  file(id, ...rel) {
    const base = this.dir(id);
    const p = path.resolve(base, ...rel);
    if (p !== base && !p.startsWith(base + path.sep)) throw new Error('path escapes the run directory');
    return p;
  }
  save(run) {
    fs.mkdirSync(this.dir(run.id), { recursive: true });
    run.updated_at = new Date().toISOString();
    const f = this.file(run.id, 'run.json');
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(run, null, 2) + '\n');
    fs.renameSync(`${f}.tmp`, f);
  }
  get(id) {
    try { return JSON.parse(fs.readFileSync(this.file(id, 'run.json'), 'utf8')); } catch { return null; }
  }
  list() {
    return fs.readdirSync(this.root).filter(d => /^[0-9a-f-]{36}$/.test(d))
      .map(d => this.get(d)).filter(Boolean)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }
  remove(id) { fs.rmSync(this.dir(id), { recursive: true, force: true }); }
}

module.exports = { Store };
