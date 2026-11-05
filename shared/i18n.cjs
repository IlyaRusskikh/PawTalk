const english = require('./en.json');
let language = 'ru';
function setLanguage(value) { language = value === 'en' ? 'en' : 'ru'; }
function t(source, ...values) {
  return (language === 'en' ? english[source] ?? source : source).replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ''));
}
module.exports = { t, setLanguage };
