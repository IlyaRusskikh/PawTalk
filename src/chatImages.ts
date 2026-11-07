import { chatEncoder, chatImageLimit, type ChatImage } from './chat.ts';

import { inspectImage as inspectMetadata } from '../shared/image.mjs';
export function inspectImage(bytes: Uint8Array): Pick<ChatImage, 'mime' | 'width' | 'height'> | undefined {
  return inspectMetadata(bytes) as Pick<ChatImage, 'mime' | 'width' | 'height'> | undefined;
}

export async function prepareChatImage(file: File): Promise<{ image: ChatImage; file: File; preview: string }> {
  if (!file.size || file.size > chatImageLimit) throw new Error('size');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const metadata = inspectImage(bytes);
  if (!metadata) throw new Error('format');
  const bitmap = await createImageBitmap(new Blob([bytes], { type: metadata.mime }));
  try { if (bitmap.width !== metadata.width || bitmap.height !== metadata.height) throw new Error('format'); }
  finally { bitmap.close(); }
  const image = { ...metadata, id: crypto.randomUUID().replaceAll('-', ''), size: file.size, name: file.name.slice(0, 128) };
  return { file, image, preview: URL.createObjectURL(new Blob([bytes], { type: image.mime })) };
}

export async function encodeImage(key: CryptoKey | undefined, image: ChatImage, file: File) {
  const clear = await file.arrayBuffer();
  if (clear.byteLength !== image.size || clear.byteLength > chatImageLimit) throw new Error('Invalid attachment size');
  if (!key) return new Uint8Array(clear);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: chatEncoder.encode('Voicecord attachment v1:' + image.id) }, key, clear);
  const payload = new Uint8Array(12 + ciphertext.byteLength); payload.set(iv); payload.set(new Uint8Array(ciphertext), 12);
  return payload;
}
export async function decodeImage(key: CryptoKey | undefined, image: ChatImage, input: Uint8Array): Promise<Blob> {
  if (!(input instanceof Uint8Array) || input.byteLength !== image.size + (key ? 28 : 0)) throw new Error('Invalid attachment size');
  const clear = key ? await crypto.subtle.decrypt({ name: 'AES-GCM', iv: input.slice(0, 12), additionalData: chatEncoder.encode('Voicecord attachment v1:' + image.id) }, key, input.slice(12)) : input;
  const bytes = new Uint8Array(clear);
  const metadata = inspectImage(bytes);
  if (!metadata || metadata.mime !== image.mime || metadata.width !== image.width || metadata.height !== image.height) throw new Error('Invalid attachment');
  return new Blob([bytes], { type: image.mime });
}
