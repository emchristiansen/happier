import type { MarkdownTableAlignment } from './parseMarkdown';

const SEPARATOR_BY_ALIGNMENT: Record<MarkdownTableAlignment, string> = {
    default: '---',
    left: ':---',
    center: ':---:',
    right: '---:',
};

function serializeRow(cells: readonly string[]): string {
    return `| ${cells.join(' | ')} |`;
}

function escapeCell(cell: string): string {
    return cell.replaceAll('|', '\\|');
}

/**
 * Rebuilds GitHub-flavored table markdown from a parsed table block (inverse of `parseMarkdownBlock`).
 * Rows are fitted to the header column count, matching what the table renders.
 */
export function serializeMarkdownTable(table: Readonly<{
    headers: readonly string[];
    rows: readonly (readonly string[])[];
    alignments: readonly MarkdownTableAlignment[];
}>): string {
    const separator = table.headers.map((_, columnIndex) =>
        SEPARATOR_BY_ALIGNMENT[table.alignments[columnIndex] ?? 'default'],
    );
    const rows = table.rows.map((row) =>
        table.headers.map((_, columnIndex) => escapeCell(row[columnIndex] ?? '')),
    );
    return [
        serializeRow(table.headers.map(escapeCell)),
        serializeRow(separator),
        ...rows.map(serializeRow),
    ].join('\n');
}
