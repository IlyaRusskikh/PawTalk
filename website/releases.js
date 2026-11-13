// textContent and validated GitHub URLs keep API data out of HTML interpretation.
const catalogURL = new URL('releases.json', import.meta.url);
const russian = document.documentElement.lang === 'ru';
const unavailable = russian ? 'Загрузки временно недоступны. Попробуйте позже.' : 'Downloads are temporarily unavailable. Please try again later.';
async function load() {
  const response = await fetch(catalogURL, { cache: 'no-cache' });
  if (!response.ok) throw Error('Catalog unavailable');
  const catalog = await response.json();
  if (catalog.schema !== 1 || catalog.repository !== 'IlyaRusskikh/PawTalk') throw Error('Invalid catalog');
  for (const element of document.querySelectorAll('[data-release]')) {
    const release = catalog.components[element.dataset.release]?.[element.dataset.channel || 'latest'];
    const url = element.dataset.asset ? release?.assets[Object.keys(release.assets).find(name => name.startsWith(element.dataset.asset))] : release?.url;
    if (!url || !/^https:\/\/github\.com\/ilyarusskikh\/pawtalk\/releases\/(?:download|tag)\//i.test(url)) continue;
    element.href = url;
    element.removeAttribute('aria-disabled');
    const channel = { stable: russian ? 'стабильный' : 'stable', preview: russian ? 'предварительный' : 'preview' }[release.channel] || (russian ? 'неизвестный канал' : 'unknown channel');
    const component = { client: 'Client', server: 'Server', manager: 'Manager' }[element.dataset.release];
    if (element.dataset.version !== undefined) element.textContent = `${component} ${release.version} (${channel})`;
  }
  const status = document.querySelector('[data-status]');
  if (status) status.textContent = russian ? 'Опубликованные выпуски из GitHub Releases. Preview — предварительный выпуск.' : 'Published releases from GitHub Releases. Preview releases are experimental.';
}
load().catch(() => {
  const status = document.querySelector('[data-status]');
  if (status) status.textContent = unavailable;
});
