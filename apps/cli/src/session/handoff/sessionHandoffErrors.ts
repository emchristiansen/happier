export class ExistingSessionStateUnavailableError extends Error {
  readonly errorCode = 'existing_session_state_unavailable';

  constructor(message: string) {
    super(message);
    this.name = 'ExistingSessionStateUnavailableError';
  }
}
