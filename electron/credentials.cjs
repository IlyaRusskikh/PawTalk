const { t } = require('../shared/i18n.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
// One OS-encrypted secret per normalized server origin. Never put passwords in renderer storage.
class CredentialStore {
  constructor(directory, encryption) { this.directory = directory; this.encryption = encryption; this.queue = Promise.resolve(); }
  file(origin) { return path.join(this.directory, createHash('sha256').update(origin).digest('hex') + '.secret'); }
  async load(origin) {
    return (await this.loadMany([origin]))[0];
  }
  loadMany(origins) {
    const operation = this.queue.catch(() => {}).then(async () => {
      if (!await this.encryption.isEncryptionAvailable()) return origins.map(() => null);
      return Promise.all(origins.map(async origin => {
        try { return await this.encryption.decryptString(await fs.readFile(this.file(origin))); }
        catch (error) { if (error.code === 'ENOENT') return null; throw new Error(t("Не удалось прочитать сохранённый пароль")); }
      }));
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  save(origin, password) {
    return this.saveMany([[origin,password]]);
  }
  saveMany(entries) {
    const operation = this.queue.catch(() => {}).then(async () => {
      const prepared = [];
      // Encrypt the whole pair before publishing either member. Reads share
      // this queue, so preview/login cannot observe a password without its key.
      for (const [origin,password] of entries) {
        if (password !== null && !await this.encryption.isEncryptionAvailable()) throw new Error(t("Защищённое сохранение пароля недоступно"));
        prepared.push([this.file(origin), password === null ? null : await this.encryption.encryptString(password)]);
      }
      for (const [target,encrypted] of prepared) {
        if (encrypted === null) { await fs.rm(target,{force:true}); continue; }
        await fs.mkdir(this.directory,{recursive:true});
        const temporary=target+'.tmp';
        await fs.writeFile(temporary,encrypted,{mode:0o600});
        await fs.rename(temporary,target);
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
module.exports = { CredentialStore };
