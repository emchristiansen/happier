import React, { useState } from 'react';
import { Text, useInput, Box } from 'ink';
import { ACCENT_HEX } from '@happier-dev/cli-common/output';
import { resolveAuthSelectorInput, type AuthMethod } from './authSelectorInput';

export type { AuthMethod } from './authSelectorInput';

interface AuthSelectorProps {
    onSelect: (method: AuthMethod) => void;
    onCancel: () => void;
}

const AUTH_OPTIONS: ReadonlyArray<Readonly<{
    method: AuthMethod;
    label: string;
    description: string;
}>> = [
    {
        method: 'mobile',
        label: 'Mobile app (recommended)',
        description: 'Scan a QR code with Happier on your phone.',
    },
    {
        method: 'web',
        label: 'Web browser',
        description: 'Open one copyable link in any browser.',
    },
];

export const AuthSelector: React.FC<AuthSelectorProps> = ({ onSelect, onCancel }) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    
    useInput((input, key) => {
        const action = resolveAuthSelectorInput(input, key, selectedIndex);
        setSelectedIndex(action.selectedIndex);
        if (action.cancelled) onCancel();
        else if (action.selectedMethod) onSelect(action.selectedMethod);
    });

    return (
        <Box flexDirection="column" paddingY={1}>
            <Box marginBottom={1}>
                <Text bold>Connect this computer</Text>
            </Box>
            <Box marginBottom={1}>
                <Text>Choose where to finish signing in. Use the same Happier account as your other devices.</Text>
            </Box>

            <Box flexDirection="column">
                {AUTH_OPTIONS.map((option, index) => {
                    const isSelected = selectedIndex === index;
                    
                    return (
                        <Box key={option.method} marginBottom={index === AUTH_OPTIONS.length - 1 ? 0 : 1} flexDirection="column">
                            <Text color={isSelected ? ACCENT_HEX : undefined} bold={isSelected}>
                                {isSelected ? '› ' : '  '}{index + 1}. {option.label}
                            </Text>
                            <Text dimColor>     {option.description}</Text>
                        </Box>
                    );
                })}
            </Box>

            <Box marginTop={1}>
                <Text dimColor>Use ↑/↓ or 1–2, then Enter. Esc cancels.</Text>
            </Box>
        </Box>
    );
};
