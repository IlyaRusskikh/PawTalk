const { writeFile } = require('node:fs/promises');
const path = require('node:path');

async function readImage(input, nativeImage, limit = 2 * 1024 * 1024) {
  if (!input || !(input.bytes instanceof Uint8Array) || input.bytes.length === 0 || input.bytes.length > limit) throw new Error('Invalid image');
  const bytes = Buffer.from(input.bytes);
  const { inspectImage } = await import('../shared/image.mjs');
  const metadata = inspectImage(bytes);
  if (!metadata) throw new Error('Unsupported image');
  const image = nativeImage?.createFromBuffer(bytes);
  if (image && (image.isEmpty() || image.getSize().width !== metadata.width || image.getSize().height !== metadata.height)) throw new Error('Invalid image dimensions');
  const extension = metadata.mime === 'image/png' ? 'png' : metadata.mime === 'image/jpeg' ? 'jpg' : 'webp';
  const stem = path.basename(typeof input.name === 'string' ? input.name : 'image', path.extname(typeof input.name === 'string' ? input.name : '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) || 'image';
  return { bytes, image, extension, name: `${stem}.${extension}` };
}

function registerImageActions({ ipcMain, authorized, nativeImage, clipboard, ClipboardItem, dialog, getWindow, t }) {
  ipcMain.handle('chat-image-copy', async (event, input) => {
    authorized(event);
    // The renderer converts clipboard images to PNG. A 16 MP PNG can exceed
    // the attachment's compressed-byte limit, but its decoded dimensions stay bounded.
    const { image } = await readImage(input, nativeImage, 64 * 1024 * 1024);
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([image.toPNG()], { type: 'image/png' }) })]);
  });
  ipcMain.handle('chat-image-save', async (event, input) => {
    authorized(event);
    const { bytes, extension, name } = await readImage(input);
    const result = await dialog.showSaveDialog(getWindow(), { title: t('Сохранить изображение'), defaultPath: name, filters: [{ name: t('Изображение'), extensions: [extension] }] });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, bytes);
    return true;
  });
}
module.exports = { readImage, registerImageActions };
