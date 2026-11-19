export type MarkdownNode = string | { type: string; text?: string; url?: string; level?: number; marker?: string; children?: MarkdownNode[] };
export function inlineMarkdown(text: string, depth?: number): MarkdownNode[];
export function messageMarkdown(text: string): MarkdownNode[];
export function messagePreview(text: string, spoiler?: string): string;
