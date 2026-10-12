import * as React from 'react';
import { InboxView } from '@/components/navigation/shell/InboxView';
import { useRequireInboxAvailable } from '@/hooks/inbox/useRequireInboxAvailable';

export default function InboxPage() {
    const enabled = useRequireInboxAvailable();
    if (!enabled) return null;
    return <InboxView />;
}
