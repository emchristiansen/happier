import { useSharedInboxSummary } from './useInboxSummary';

// Hook to check if inbox has content to show
export function useInboxHasContent(): boolean {
    return useSharedInboxSummary().hasContent;
}
