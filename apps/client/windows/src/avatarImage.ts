export const avatarSize = 128;
export const avatarPayloadLimit = 12000;
export const avatarFileLimit = 10 * 1024 * 1024;
export const avatarFormats = ['image/png', 'image/jpeg', 'image/webp'];
export const avatarStorageKey = 'pawtalk.avatar';

export function validAvatar(value: string): boolean {
  const prefix = 'data:image/webp;base64,';
  if (value.length > avatarPayloadLimit || !value.startsWith(prefix)) return false;
  try {
    const bytes = atob(value.slice(prefix.length));
    const byte = (offset: number) => bytes.charCodeAt(offset);
    const uint16 = (offset: number) => byte(offset) | (byte(offset + 1) << 8);
    const uint32 = (offset: number) => (uint16(offset) | (uint16(offset + 2) << 16)) >>> 0;
    if (bytes.slice(0, 4) !== 'RIFF' || bytes.slice(8, 12) !== 'WEBP' || uint32(4) !== bytes.length - 8) return false;
    // Chromium may include an extended header and a color profile before the
    // lossy frame. Check both sets of dimensions and reject animation/alpha.
    let frame = false;
    for (let offset = 12; offset < bytes.length;) {
      if (offset + 8 > bytes.length) return false;
      const tag = bytes.slice(offset, offset + 4);
      const length = uint32(offset + 4);
      const start = offset + 8;
      const next = start + length + length % 2;
      if (next > bytes.length) return false;
      if (tag === 'VP8X') {
        if (offset !== 12 || length !== 10 || (byte(start) & ~0x20)
          || (uint32(start + 4) & 0xffffff) !== avatarSize - 1
          || (uint16(start + 7) | (byte(start + 9) << 16)) !== avatarSize - 1) return false;
      } else if (tag === 'VP8 ') {
        if (frame || length < 10 || bytes.slice(start + 3, start + 6) !== '\x9d\x01\x2a'
          || (uint16(start + 6) & 0x3fff) !== avatarSize || (uint16(start + 8) & 0x3fff) !== avatarSize) return false;
        frame = true;
      } else if (tag !== 'ICCP') return false;
      offset = next;
    }
    return frame;
  } catch { return false; }
}

export type AvatarCrop = { zoom: number; x: number; y: number };

export function drawAvatar(canvas: HTMLCanvasElement, image: ImageBitmap, crop: AvatarCrop) {
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return false;
  const size = Math.min(image.width, image.height) / crop.zoom;
  context.fillStyle = '#242731';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, (image.width - size) * crop.x, (image.height - size) * crop.y, size, size, 0, 0, canvas.width, canvas.height);
  return true;
}

export function encodeAvatar(image: ImageBitmap, crop: AvatarCrop): string | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = avatarSize;
  if (!drawAvatar(canvas, image, crop)) return;
  for (const quality of [0.88, 0.75, 0.6, 0.45, 0.3]) {
    const data = canvas.toDataURL('image/webp', quality);
    if (validAvatar(data)) return data;
  }
}
