import { useSyncExternalStore } from 'react';
import english from '../shared/en.json';
export type Language = 'ru' | 'en';
let language: Language = 'ru';
const listeners = new Set<() => void>();
function apply(value: Language) { language = value; document.documentElement.lang = value; listeners.forEach(listener => listener()); }
export function t(source: string, ...values: unknown[]): string {
  const dictionary: Record<string, string> = english;
  return (language === 'en' ? dictionary[source] ?? source : source).replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ''));
}
export async function initializeLanguage() {
  try {
    const value = await window.desktop?.getLanguage?.() ?? localStorage.getItem('voicecord.language');
    apply(value === 'en' ? 'en' : 'ru');
  } catch { apply('ru'); }
}
export async function changeLanguage(value: Language) {
  await window.desktop?.setLanguage?.(value);
  localStorage.setItem('voicecord.language', value);
  apply(value);
}
export function useLanguage() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => language);
}
