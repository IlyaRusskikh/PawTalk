import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ComponentPropsWithRef } from 'react';
import { createPortal } from 'react-dom';
import { t } from './i18n';

const formats = [
  { label: 'Жирный', mark: '**', glyph: <b>B</b> },
  { label: 'Курсив', mark: '*', glyph: <i>I</i> },
  { label: 'Подчёркнутый', mark: '__', glyph: <u>U</u> },
  { label: 'Зачёркнутый', mark: '~~', glyph: <s>S</s> },
  { label: 'Цитата', mark: '>', glyph: '❝' },
  { label: 'Код', mark: '`', glyph: '‹›' },
  { label: 'Спойлер', mark: '||', glyph: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M2 12s4-8 10-8 10 8 10 8-4 8-10 8S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg> },
];

// A mirror gives textarea selections real line/wrap coordinates without changing focus.
function selectionPosition(input: HTMLTextAreaElement) {
  const rect = input.getBoundingClientRect(), style = getComputedStyle(input);
  const mirror = document.createElement('div');
  for (const property of ['font', 'letter-spacing', 'line-height', 'padding', 'border', 'box-sizing', 'tab-size', 'word-break', 'overflow-wrap']) {
    mirror.style.setProperty(property, style.getPropertyValue(property));
  }
  const width = input.clientWidth + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
  Object.assign(mirror.style, { position: 'fixed', visibility: 'hidden', whiteSpace: 'pre-wrap', width: `${width}px`, left: `${rect.left}px`, top: `${rect.top}px` });
  mirror.textContent = input.value.slice(0, input.selectionStart);
  const selected = document.createElement('span');
  selected.textContent = input.value.slice(input.selectionStart, input.selectionEnd);
  mirror.append(selected, document.createTextNode(input.value.slice(input.selectionEnd) || '\u200b'));
  document.body.append(mirror);
  const line = selected.getClientRects()[0] ?? selected.getBoundingClientRect();
  const position = { x: Math.max(rect.left, Math.min(rect.right, line.left - input.scrollLeft + line.width / 2)), y: Math.max(rect.top, line.top - input.scrollTop) };
  mirror.remove();
  return position;
}

export function FormattingTextarea({ ref, onEscape, ...props }: ComponentPropsWithRef<'textarea'> & { onEscape?(): void }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const restore = useRef<{ start: number; end: number } | undefined>(undefined);
  const selecting = useRef<number | undefined>(undefined);
  const [position, setPosition] = useState<{ x: number; y: number }>();
  useImperativeHandle(ref, () => input.current!, []);

  useEffect(() => {
    const update = () => {
      if (selecting.current !== undefined) return;
      const field = input.current;
      if (!field || field.disabled || field.readOnly || field.selectionStart === field.selectionEnd ||
        (document.activeElement !== field && !toolbar.current?.contains(document.activeElement))) {
        setPosition(undefined); return;
      }
      setPosition(selectionPosition(field));
    };
    const dismiss = (event: PointerEvent) => {
      if (event.target === input.current) {
        selecting.current = event.pointerId;
        setPosition(undefined);
        return;
      }
      if (event.target !== input.current && !toolbar.current?.contains(event.target as Node)) setPosition(undefined);
    };
    const release = (event: PointerEvent) => {
      if (selecting.current !== event.pointerId) return;
      selecting.current = undefined;
      update();
    };
    const blur = () => { selecting.current = undefined; setPosition(undefined); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onEscape && input.current?.contains(document.activeElement)) {
        event.preventDefault(); event.stopPropagation(); setPosition(undefined); onEscape(); return;
      }
      if (event.key === 'Escape' && toolbar.current) {
        event.preventDefault(); event.stopPropagation();
        input.current?.focus(); setPosition(undefined);
      }
    };
    document.addEventListener('selectionchange', update);
    document.addEventListener('focusin', update);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('pointerup', release);
    document.addEventListener('pointercancel', blur);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', update);
    window.addEventListener('blur', blur);
    document.addEventListener('scroll', update, true);
    return () => {
      document.removeEventListener('selectionchange', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('pointerup', release);
      document.removeEventListener('pointercancel', blur);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', update);
      window.removeEventListener('blur', blur);
      document.removeEventListener('scroll', update, true);
    };
  }, [onEscape]);

  useLayoutEffect(() => {
    if (restore.current && input.current) {
      input.current.setSelectionRange(restore.current.start, restore.current.end);
      restore.current = undefined;
    }
    if (props.disabled || props.readOnly || !props.value) setPosition(undefined);
  }, [props.value, props.disabled, props.readOnly]);

  useLayoutEffect(() => {
    if (!position || !toolbar.current) return;
    const bar = toolbar.current, rect = bar.getBoundingClientRect();
    bar.style.left = `${Math.max(8, Math.min(window.innerWidth - rect.width - 8, position.x - rect.width / 2))}px`;
    const fieldTop = input.current?.getBoundingClientRect().top ?? position.y;
    const above = Math.min(position.y, fieldTop) - rect.height - 8;
    bar.style.top = `${above >= 8 ? above : Math.min(window.innerHeight - rect.height - 8, (input.current?.getBoundingClientRect().bottom ?? position.y) + 8)}px`;
  }, [position]);

  function apply(mark: string) {
    const field = input.current;
    if (!field || field.readOnly || field.disabled) return;
    let start = field.selectionStart, end = field.selectionEnd;
    if (start === end) return;
    const text = field.value;
    let replacement: string, selectedStart: number, selectedEnd: number;
    if (mark === '>') {
      start = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
      const selected = text.slice(start, end);
      const quoted = selected.split('\n').every(line => line.startsWith('> '));
      replacement = selected.split('\n').map(line => quoted ? line.slice(2) : `> ${line}`).join('\n');
      selectedStart = start; selectedEnd = start + replacement.length;
    } else if (text.slice(Math.max(0, start - mark.length), start) === mark && text.slice(end, end + mark.length) === mark &&
      // A pair of stars is bold; italic should combine with it rather than remove half.
      !(mark === '*' && /(?:^|[^*])\*\*$/.test(text.slice(0, start)) && /^\*\*(?:[^*]|$)/.test(text.slice(end)))) {
      replacement = text.slice(start, end); start -= mark.length; end += mark.length;
      selectedStart = start; selectedEnd = start + replacement.length;
    } else {
      const selected = text.slice(start, end);
      replacement = mark + selected + mark;
      selectedStart = start + mark.length; selectedEnd = selectedStart + selected.length;
    }
    if (props.maxLength && text.length - (end - start) + replacement.length > props.maxLength) return;
    field.focus({ preventScroll: true });
    field.setSelectionRange(start, end);
    restore.current = { start: selectedStart, end: selectedEnd };
    // Chromium's edit command preserves native undo and dispatches React's input event.
    if (!document.execCommand('insertText', false, replacement)) restore.current = undefined;
  }

  return <><textarea {...props} ref={input}/>{position && createPortal(<div ref={toolbar} className="chat-format-toolbar" role="toolbar" aria-label={t('Форматирование текста')} onPointerDown={event => event.preventDefault()}>
    {formats.map(format => <button key={format.mark} type="button" aria-label={t(format.label)} title={t(format.label)} onClick={() => apply(format.mark)}>{format.glyph}</button>)}
  </div>, input.current?.closest('dialog') ?? document.body)}</>;
}
