const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
// One OS-encrypted secret per normalized server origin. Never put passwords in renderer storage.
class CredentialStore {
  constructor(directory, encryption) { this.directory = directory; this.encryption = encryption; this.queue = Promise.resolve(); }
  file(origin) { return path.join(this.directory, createHash('sha256').update(origin).digest('hex') + '.secret'); }
  async load(origin) {
    await this.queue;
    if (!await this.encryption.isEncryptionAvailable()) return null;
    try { return await this.encryption.decryptString(await fs.readFile(this.file(origin))); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Не удалось прочитать сохранённый пароль'); }
  }
  save(origin, password) {
    const operation = this.queue.catch(() => {}).then(async () => {
      if (password === null) { await fs.rm(this.file(origin), { force: true }); return; }
      if (!await this.encryption.isEncryptionAvailable()) throw new Error('Защищённое сохранение пароля недоступно');
      const encrypted = await this.encryption.encryptString(password);
      await fs.mkdir(this.directory, { recursive: true });
      const target = this.file(origin), temporary = target + '.tmp';
      await fs.writeFile(temporary, encrypted, { mode: 0o600 });
      await fs.rename(temporary, target);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
module.exports = { CredentialStore };
