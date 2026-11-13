// Concurrent tray/second-instance requests share one load and first-render gate.
function createShowWindow(win, load, ready) {
  let loading;
  return async function show() {
    if (!loading) loading = Promise.all([load(), ready]).catch(error => { loading = undefined; throw error; });
    await loading;
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };
}
module.exports = { createShowWindow };
