export function inspectImage(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  let width = 0, height = 0, mime;
  if (bytes.length >= 24 && text(1, 3) === 'PNG' && bytes[0] === 137 && text(12, 4) === 'IHDR') {
    width = view.getUint32(16); height = view.getUint32(20); mime = 'image/png';
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      if (text(offset + 4, 4) === 'acTL') return; // Keep decoded memory predictable: static images only.
      offset += length + 12;
    }
  } else if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216) {
    mime = 'image/jpeg';
    for (let offset = 2; offset + 4 < bytes.length;) {
      if (bytes[offset++] !== 255) return;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > bytes.length) return;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) return;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) {
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break;
      }
      offset += length;
    }
  } else if (bytes.length >= 30 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    mime = 'image/webp'; const chunk = text(12, 4);
    if (chunk === 'VP8X') {
      if (bytes[20] & 2) return;
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (chunk === 'VP8 ' && text(23, 3) === '\x9d\x01\x2a') {
      width = view.getUint16(26, true) & 16383; height = view.getUint16(28, true) & 16383;
    } else if (chunk === 'VP8L' && bytes[20] === 47) {
      const bits = view.getUint32(21, true); width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1;
    }
  }
  if (mime && width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16000000) return { mime, width, height };
}
