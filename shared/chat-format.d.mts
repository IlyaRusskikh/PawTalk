export type MarkdownNode = string | { type: string; text?: string; url?: string; level?: number; children?: MarkdownNode[] };
export function inlineMarkdown(text: string, depth?: number): MarkdownNode[];
export function messageMarkdown(text: string): MarkdownNode[];
