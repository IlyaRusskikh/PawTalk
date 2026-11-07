// An empty system clipboard can be returned as either [] or an item with no
// advertised MIME types. Only writable items may be reconstructed for restore.
async function snapshotClipboard(clipboard, ClipboardItem) {
  const items = await clipboard.read();
  return Promise.all(items.filter(item => item.types.length > 0).map(async item => {
    const entries = await Promise.all(item.types.map(async type => [type, await item.getType(type)]));
    return new ClipboardItem(Object.fromEntries(entries));
  }));
}
module.exports = { snapshotClipboard };
