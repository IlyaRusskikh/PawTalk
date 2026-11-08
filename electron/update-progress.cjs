const fs = require('node:fs/promises');
const path = require('node:path');

const labels = {
  ru: { title: 'Обновление PawTalk', waiting: 'Закрываем приложение…', installing: 'Устанавливаем новую версию…', starting: 'Запускаем PawTalk…', done: 'Обновление завершено', failure: 'Обновление не завершено', details: 'Подробности сохранены в журнале:', elapsed: 'Прошло', seconds: 'сек.', hint: 'Это может занять несколько минут. Дождитесь запуска приложения.' },
  en: { title: 'PawTalk update', waiting: 'Closing the app…', installing: 'Installing the new version…', starting: 'Starting PawTalk…', done: 'Update complete', failure: 'Update did not complete', details: 'Details were saved to the log:', elapsed: 'Elapsed', seconds: 'sec.', hint: 'This may take a few minutes. Please wait for the app to start.' },
};
function helperLaunch(executable, args, directory) {
  const quoteArgument = value => '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
  const quotePS = value => "'" + value.replaceAll("'", "''") + "'";
  // Ask the interactive Windows shell to own the helper so it survives the
  // Electron process/console/job closing. The bootstrap itself stays hidden.
  const command = `$shell=New-Object -ComObject Shell.Application; $shell.ShellExecute(${quotePS(executable)},${quotePS(args.map(quoteArgument).join(' '))},${quotePS(directory)},'open',0)`;
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')];
}
async function waitForHelper(file, token, child, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if ((child.exitCode != null && child.exitCode !== 0) || child.signalCode != null) throw new Error('Update helper exited before initialization');
    try { if ((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '').trim() === token) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error('Update helper did not become ready');
}
async function confirmUpdateStarted(directory, version, executable, pid = process.pid) {
  const file = path.join(directory, 'installation.json');
  try {
    const state = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
    if (state.version !== version || state.executable !== executable || !['installing', 'starting'].includes(state.phase) || typeof state.token !== 'string') return false;
    await fs.writeFile(file, JSON.stringify({ ...state, phase: 'launched', pid }));
    return true;
  } catch { return false; }
}
module.exports = { labels, helperLaunch, waitForHelper, confirmUpdateStarted };
