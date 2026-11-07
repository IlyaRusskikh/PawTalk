const fs = require('node:fs');
const path = require('node:path');
class UpdatePreferences {
  constructor(file) {
    this.file = file; this.enabled = true;
    try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (typeof saved.enabled === 'boolean') this.enabled = saved.enabled; } catch {}
  }
  setEnabled(value) {
    if (typeof value !== 'boolean') throw new Error('Invalid update preference');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ enabled: value }));
    fs.renameSync(this.file + '.tmp', this.file);
    this.enabled = value; return value;
  }
}
module.exports = { UpdatePreferences };
