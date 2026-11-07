export type Theme = {
  accent: string; background: string; surface: string; sidebar: string; chat: string; text: string; muted: string; border: string;
  success: string; warning: string; danger: string; onAccent: string; shadow: string;
  radius: number; fontSize: number; messageSpacing: number;
};
export const defaultTheme: Theme = { accent: '#8e83ff', background: '#191b22', surface: '#242731', sidebar: '#11141a', chat: '#20222b', text: '#eceef5', muted: '#898d9f', border: '#30333f', success: '#78d4aa', warning: '#e5bd64', danger: '#ef8ca4', onAccent: '#12141a', shadow: '#090b13', radius: 12, fontSize: 13, messageSpacing: 6 };
export const themePresets = [
  { ...defaultTheme, name: 'Лаванда' },
  { ...defaultTheme, name: 'Океан', accent: '#6abedb', background: '#111a22', surface: '#1d2a35', sidebar: '#0d151c', chat: '#18232e', border: '#304252' },
  { ...defaultTheme, name: 'Мята', accent: '#7bcdb0', background: '#141d1b', surface: '#222e2a', sidebar: '#0f1613', chat: '#1a2621', border: '#35453c' },
  { ...defaultTheme, name: 'Роза', accent: '#e6a0b7', background: '#20171e', surface: '#30252e', sidebar: '#181016', chat: '#291e26', border: '#483542' },
  { ...defaultTheme, name: 'Янтарь', accent: '#dfbb78', background: '#201c17', surface: '#302a22', sidebar: '#181510', chat: '#28231c', border: '#463d31' },
  { ...defaultTheme, name: 'Светлая', accent: '#635bda', background: '#f4f5fa', surface: '#ffffff', sidebar: '#e9ecf4', chat: '#ffffff', text: '#252b3d', muted: '#667085', border: '#dbe0eb', success: '#237847', warning: '#8a6114', danger: '#a83450', onAccent: '#ffffff', shadow: '#18203a' },
] satisfies (Theme & { name: string })[];
export const validColor = (value: unknown): value is string => typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value);
export const colorFields = ['accent', 'background', 'surface', 'sidebar', 'chat', 'text', 'muted', 'border', 'success', 'warning', 'danger', 'onAccent', 'shadow'] as const;
export function normalizeTheme(saved: unknown): Theme {
  const result = { ...defaultTheme };
  if (!saved || typeof saved !== 'object') return result;
  const source = saved as Record<string, unknown>;
  // Existing two-color preferences migrate to a readable complete palette.
  const light = validColor(source.background) && luminance(source.background) > .35;
  if (light) Object.assign(result, themePresets[5]);
  for (const key of colorFields) if (validColor(source[key])) result[key] = source[key];
  if (!validColor(source.onAccent)) result.onAccent = luminance(result.accent) > .179 ? defaultTheme.onAccent : themePresets[5].onAccent;
  for (const [key, min, max] of [['radius', 4, 24], ['fontSize', 12, 18], ['messageSpacing', 2, 12]] as const) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = Math.min(max, Math.max(min, Math.round(value)));
  }
  return result;
}
export function loadTheme(): Theme {
  try { return normalizeTheme(JSON.parse(localStorage.getItem('voicecord.theme') ?? '{}')); }
  catch { return { ...defaultTheme }; }
}
export function luminance(color: string) {
  const rgb = color.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
export function applyTheme(theme: Theme) {
  const style = document.documentElement.style;
  for (const [variable, key] of [['--accent', 'accent'], ['--app-bg', 'background'], ['--surface', 'surface'], ['--panel', 'surface'], ['--sidebar-bg', 'sidebar'], ['--chat-bg', 'chat'], ['--text', 'text'], ['--muted', 'muted'], ['--line', 'border'], ['--success', 'success'], ['--warning', 'warning'], ['--danger', 'danger'], ['--on-accent', 'onAccent'], ['--shadow', 'shadow']] as const) style.setProperty(variable, theme[key]);
  const light = luminance(theme.background) > .35;
  style.setProperty('--shade', theme.text);
  style.setProperty('--ui-radius', theme.radius + 'px');
  style.setProperty('--ui-font-size', theme.fontSize + 'px');
  style.setProperty('--message-spacing', theme.messageSpacing + 'px');
  style.setProperty('color-scheme', light ? 'light' : 'dark');
}
