// Expected hosting failures cross IPC as data, without Electron's error wrapper.
class HostError extends Error {}
async function hostResult(operation, fallback) {
  try { return { value: await operation() }; }
  catch (error) { return { error: error instanceof HostError ? error.message : fallback }; }
}
module.exports = { HostError, hostResult };
