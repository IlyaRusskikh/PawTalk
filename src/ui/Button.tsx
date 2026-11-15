import type {ButtonHTMLAttributes} from 'react';
export function Button({variant='secondary',className='',...props}:ButtonHTMLAttributes<HTMLButtonElement>&{variant?:'primary'|'secondary'|'quiet'|'danger'}){return <button {...props} className={`ui-button ui-button-${variant} ${variant==='primary'?'primary':variant==='danger'?'danger-button':''} ${className}`}/>;}
