export async function deleteNewSessionDraftAfterConfirmation(params: Readonly<{
    confirm: () => Promise<boolean>;
    readCurrentDraftDeletionDisposition: () => 'deletable' | 'missing' | 'launch-custody';
    deleteDraft: () => Promise<boolean>;
}>): Promise<boolean> {
    if (!await params.confirm()) return false;
    if (params.readCurrentDraftDeletionDisposition() !== 'deletable') return false;
    return params.deleteDraft();
}
