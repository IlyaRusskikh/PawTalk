export type ChatImage = { id: string; name: string; mime: 'image/png' | 'image/jpeg' | 'image/webp'; size: number; width: number; height: number };
export const chatImageLimit = 2 * 1024 * 1024;

import { inspectImage as inspectMetadata } from '../../../../shared/image.mjs';
export function inspectImage(bytes: Uint8Array): Pick<ChatImage, 'mime' | 'width' | 'height'> | undefined {
  return inspectMetadata(bytes) as Pick<ChatImage, 'mime' | 'width' | 'height'> | undefined;
}
