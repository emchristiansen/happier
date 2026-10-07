/** Insets of the header row, keeping trailing actions in their existing column. */
export function resolveChatHeaderContentInsets(input: Readonly<{
    containerWidth: number;
    maxWidth: number;
    contentTrailingInsetPx: number;
    constrainWidth: boolean;
}>): Readonly<{ leading: number; trailing: number }> {
    if (!input.constrainWidth) return { leading: 0, trailing: 0 };
    const trailing = Math.max(0, (input.containerWidth - input.maxWidth) / 2);
    const leading = Math.max(0, (input.containerWidth - input.contentTrailingInsetPx - input.maxWidth) / 2);
    return { leading, trailing };
}
