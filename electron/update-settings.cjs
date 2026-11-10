const fs = require('node:fs');
const path = require('node:path');
class UpdatePreferences {
  constructor(file) {
    this.file = file; this.enabled = true; this.channel = 'preview';
    try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (typeof saved.enabled === 'boolean') this.enabled = saved.enabled;
      if (['stable', 'preview'].includes(saved.channel)) this.channel = saved.channel; } catch {}
  }
  persist(enabled, channel) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ enabled, channel }));
    fs.renameSync(this.file + '.tmp', this.file);
    this.enabled = enabled; this.channel = channel;
  }
  setEnabled(value) {
    if (typeof value !== 'boolean') throw new Error('Invalid update preference');
    this.persist(value, this.channel); return value;
  }
  setChannel(value) {
    if (!['stable', 'preview'].includes(value)) throw new Error('Invalid update channel');
    this.persist(this.enabled, value); return value;
  }
}
module.exports = { UpdatePreferences };
