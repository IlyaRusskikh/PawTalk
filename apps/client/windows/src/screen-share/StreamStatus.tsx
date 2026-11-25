import { Icon } from '../Controls';

export function PawSpinner() {
  return <span className="stream-paw-spinner" aria-hidden="true">
    <Icon name="paw" size={17}/><Icon name="paw" size={17}/><Icon name="paw" size={17}/>
  </span>;
}

export function BlindfoldCat() {
  return <svg className="stream-blindfold-cat" viewBox="0 0 92 74" fill="none" aria-hidden="true">
    <ellipse cx="47" cy="68" rx="31" ry="4" fill="currentColor" opacity=".16"/>
    <path d="M63 61c17 3 23-3 18-12-3-5-2-8 1-9" stroke="currentColor" strokeWidth="5" strokeLinecap="round" opacity=".55"/>
    <path d="M31 64c-2-19 6-27 15-27s18 8 16 27H31Z" fill="currentColor" opacity=".55"/>
    <path d="M23 24 24 8c0-2 2-3 4-2l11 8a32 32 0 0 1 13 0l11-8c2-1 4 0 4 2l1 16c4 5 5 12 1 17-5 7-15 10-23 10s-18-3-23-10c-4-5-3-12 0-17Z" fill="currentColor"/>
    <path d="m28 11 8 6-8 3V11Zm35 0-8 6 8 3V11Z" fill="var(--surface)" opacity=".55"/>
    <path d="M20 27q26 5 51 0l-1 12q-24 5-49 0l-1-12Z" fill="var(--surface)"/>
    <path d="m71 33 8-7m-8 9 10 2" stroke="var(--surface)" strokeWidth="4" strokeLinecap="round"/>
    <path d="M43 44h6m-13 19h6m9 0h6" stroke="var(--surface)" strokeWidth="2" strokeLinecap="round"/>
  </svg>;
}
