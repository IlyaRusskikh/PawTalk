export type ChatImage = { id: string; name: string; mime: 'image/png' | 'image/jpeg' | 'image/webp'; size: number; width: number; height: number };
export const chatImageLimit = 2 * 1024 * 1024;

import { inspectImage as inspectMetadata } from '../../../../shared/image.mjs';
export function inspectImage(bytes: Uint8Array): Pick<ChatImage, 'mime' | 'width' | 'height'> | undefined {
  return inspectMetadata(bytes) as Pick<ChatImage, 'mime' | 'width' | 'height'> | undefined;
}

const imageSizes = new Map<string, Pick<ChatImage, 'width' | 'height'>>();
export function rememberChatImageSize(serverId: string, channelId: string, id: string, { width, height }: Pick<ChatImage, 'width' | 'height'>) {
  imageSizes.set(`${serverId}:${channelId}:${id}`, { width, height });
  if (imageSizes.size > 256) imageSizes.delete(imageSizes.keys().next().value!);
}

export function rememberSentImageSize(serverId: string, channelId: string, id: string, bytes: Uint8Array) {
  const image = inspectImage(bytes);
  if (image) rememberChatImageSize(serverId, channelId, id, image);
}
export function chatImageSize(serverId: string, channelId: string, id: string) {
  return imageSizes.get(`${serverId}:${channelId}:${id}`);
}

export async function copyChatImage(source: Blob | HTMLImageElement, name: string) {
  const image = source instanceof Blob ? await createImageBitmap(source) : source;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
    canvas.height = image instanceof HTMLImageElement ? image.naturalHeight : image.height;
    canvas.getContext('2d')!.drawImage(image, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(value => value ? resolve(value) : reject(Error('Image encoding failed')), 'image/png'));
    if (window.desktop?.copyChatImage) await window.desktop.copyChatImage({ bytes: new Uint8Array(await png.arrayBuffer()), name });
    else await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  } finally {
    if (image instanceof ImageBitmap) image.close();
  }
}

// Bound concurrent fetch and decryption for both legacy images and gallery previews.
function mediaQueue(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(load: () => Promise<T>) => {
    if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve));
    else active++;
    try { return await load(); }
    finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

export const withImageSlot = mediaQueue(2);
export const withProtectedPreviewSlot = mediaQueue(3);
export const withProtectedFileSlot = mediaQueue(1);

export function attachmentBlob(bytes: Uint8Array, mime: string) {
  const { buffer, byteOffset, byteLength } = bytes;
  const data = buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength
    ? buffer : new Uint8Array(bytes);
  return new Blob([data], { type: mime });
}
