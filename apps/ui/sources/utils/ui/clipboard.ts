import * as Clipboard from 'expo-clipboard';

export async function getClipboardStringTrimmedSafe(): Promise<string> {
    try {
        return (await Clipboard.getStringAsync()).trim();
    } catch {
        return '';
    }
}

export async function setClipboardStringSafe(value: string): Promise<boolean> {
    try {
        const copied = await Clipboard.setStringAsync(value);
        if (!copied) console.warn('Clipboard write was refused by the platform.');
        return copied;
    } catch {
        console.warn('Clipboard write failed.');
        return false;
    }
}
