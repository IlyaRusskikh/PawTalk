const fs = require('node:fs');
const path = require('node:path');
const { serverURL, invitation } = require('./address.cjs');
function normalizeRooms(value) {
  if (!Array.isArray(value) || value.length > 50) throw Error('Invalid update rooms');
  return value.map(room => {
    if (!room || typeof room.address !== 'string' || room.address.includes('#') || typeof room.name !== 'string') throw Error('Invalid update room');
    serverURL(room.address);
    return { address: room.address.trim(), name: room.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) || new URL(serverURL(room.address)).host };
  });
}
class UpdateRooms {
  constructor(file, { effective = address => address, verify, trust }) {
    Object.assign(this, { file, effective, verify, trust }); this.saved = [];
    try { this.saved = normalizeRooms(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {}
  }
  set(value) {
    const saved = normalizeRooms(value);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(saved)); fs.renameSync(this.file + '.tmp', this.file);
    this.saved = saved;
  }
  sources() {
    return this.saved.map(room => ({ name: room.name, prepare: async () => {
      const address = this.effective(room.address);
      const base = serverURL(address);
      if (invitation(address)) { await this.verify(address); this.trust(address); }
      return { base };
    } }));
  }
}
module.exports = { UpdateRooms, normalizeRooms };
