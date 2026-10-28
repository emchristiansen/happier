export type AuthMethod = 'mobile' | 'web';

type AuthSelectorKey = Readonly<{
    upArrow?: boolean;
    downArrow?: boolean;
    return?: boolean;
    escape?: boolean;
    ctrl?: boolean;
}>;

export function resolveAuthSelectorInput(
    input: string,
    key: AuthSelectorKey,
    selectedIndex: number,
): Readonly<{ selectedIndex: number; selectedMethod?: AuthMethod; cancelled?: boolean }> {
    if (key.escape || (key.ctrl && input === 'c')) return { selectedIndex, cancelled: true };
    if (input === '1') return { selectedIndex: 0, selectedMethod: 'mobile' };
    if (input === '2') return { selectedIndex: 1, selectedMethod: 'web' };
    if (key.upArrow) return { selectedIndex: Math.max(0, selectedIndex - 1) };
    if (key.downArrow) return { selectedIndex: Math.min(1, selectedIndex + 1) };
    const selectedMethod: AuthMethod | undefined = key.return ? (['mobile', 'web'] as const)[selectedIndex] : undefined;
    return selectedMethod ? { selectedIndex, selectedMethod } : { selectedIndex };
}
