import type { Socket } from 'socket.io-client';

export class SocketRpcDisconnectBeforeAcknowledgementError extends Error {
  constructor() {
    super('RPC socket disconnected before acknowledgement');
    this.name = 'SocketRpcDisconnectBeforeAcknowledgementError';
  }
}

export function isSocketRpcDisconnectBeforeAcknowledgementError(
  error: unknown,
): error is SocketRpcDisconnectBeforeAcknowledgementError {
  return error instanceof SocketRpcDisconnectBeforeAcknowledgementError;
}

export function createSocketRpcDisconnectGuard(params: Readonly<{
  socket: Socket;
  createError: () => Error;
  onDisconnect?: () => void;
}>): Readonly<{
  disconnected: Promise<never>;
  throwIfDisconnected: () => void;
  dispose: () => void;
}> {
  let disposed = false;
  let disconnectError: Error | null = null;
  let rejectDisconnected!: (error: Error) => void;
  const disconnected = new Promise<never>((_resolve, reject) => {
    rejectDisconnected = reject;
  });
  const onDisconnect = () => {
    if (disposed || disconnectError) return;
    const error = params.createError();
    disconnectError = error;
    try {
      params.onDisconnect?.();
    } catch {
      // Preserve the transport failure. Callers use socket teardown as the
      // server-side cancellation backstop when an explicit cancel cannot send.
    }
    rejectDisconnected(error);
  };

  params.socket.on('disconnect', onDisconnect);

  return {
    disconnected,
    throwIfDisconnected: () => {
      if (disconnectError) throw disconnectError;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      params.socket.off('disconnect', onDisconnect);
    },
  };
}
