export type ConnectedServiceImportErrorCode =
  | 'credentials_unavailable'
  | 'reauthorization_required'
  | 'unsupported_source'
  | 'provider_error';

/** Only fixed, credential-free provider messages may cross the import boundary. */
export class ConnectedServiceImportError extends Error {
  constructor(readonly code: ConnectedServiceImportErrorCode, message: string) {
    super(message);
    this.name = 'ConnectedServiceImportError';
  }
}
