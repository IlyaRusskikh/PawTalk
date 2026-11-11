// Protocol numbers describe API contracts, independently of component versions.
function protocol(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw Object.assign(Error('Invalid API policy'), { code: 'PAWTALK_PROTOCOL' });
  const version = Object.hasOwn(config, 'apiProtocolVersion') ? config.apiProtocolVersion : 1; // Published 0.8.0 has no field.
  if (version !== 1) throw Object.assign(Error('Unsupported API protocol'), { code: 'PAWTALK_PROTOCOL' });
  return { version, capabilities: Array.isArray(config.capabilities) ? config.capabilities.filter(v => typeof v === 'string') : [] };
}
module.exports = { protocol };
