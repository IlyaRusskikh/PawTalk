const digits = [
  '111 101 101 101 111', '010 110 010 010 111', '111 001 111 100 111',
  '111 001 111 001 111', '101 101 111 001 001', '111 100 111 001 111',
  '111 100 111 101 111', '111 001 010 010 010', '111 101 111 101 111',
  '111 101 111 001 111',
];
const plus = '000 010 111 010 000';

function taskbarBadge(nativeImage, count) {
  if (!count) return null;
  const rasterScale = 3;
  const size = 16 * rasterScale;
  const bitmap = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / rasterScale;
      if (distance < 7.4) bitmap.writeUInt32LE(distance < 6.7 ? 0xfff04357 : 0xffffb4bb, (y * size + x) * 4);
    }
  }
  const label = count > 99 ? '99+' : String(count);
  const scale = label.length === 1 ? 5 : rasterScale;
  const left = Math.floor((size - (4 * label.length - 1) * scale) / 2);
  const top = Math.floor((size - 5 * scale) / 2);
  for (const [index, digit] of [...label].entries()) {
    const rows = (digit === '+' ? plus : digits[Number(digit)]).split(' ');
    for (let y = 0; y < 5 * scale; y++) {
      for (let x = 0; x < 3 * scale; x++) {
        if (rows[Math.floor(y / scale)][Math.floor(x / scale)] === '1') {
          bitmap.writeUInt32LE(0xffffffff, ((top + y) * size + left + index * 4 * scale + x) * 4);
        }
      }
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size }).resize({ width: 16, height: 16, quality: 'best' });
}

module.exports = { taskbarBadge };
