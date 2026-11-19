function externalLinkHandler(openExternal) {
  return ({ url }) => {
    try {
      if (typeof url !== 'string' || url.length > 8192 || /[\u0000-\u0020\u007f]/.test(url)) return { action: 'deny' };
      const target = new URL(url);
      if (['https:', 'http:'].includes(target.protocol) && !target.username && !target.password) {
        // Keep navigation out of the app. An unavailable browser must not cause
        // an unhandled rejection in the main process.
        void Promise.resolve().then(() => openExternal(target.href)).catch(() => {});
      }
    } catch { /* Malformed or unsupported destinations stay blocked. */ }
    return { action: 'deny' };
  };
}

module.exports = { externalLinkHandler };
