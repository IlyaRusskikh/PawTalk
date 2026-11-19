import { useState } from 'react';

export function Avatar({ name, image, className = '' }: { name: string; image?: string; className?: string }) {
  const [failed, setFailed] = useState<string>();
  const characters = Array.from(name.trim());
  const color = characters.reduce((value, character) => (value + character.codePointAt(0)!) % 4, 0);
  return <span className={`avatar color-${color} ${className}`} aria-hidden="true">
    {image && image !== failed ? <img src={image} alt="" onError={() => setFailed(image)}/> : characters[0]?.toUpperCase() || '?'}
  </span>;
}
