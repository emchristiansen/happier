import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { streamToStdin } from './utils';

async function* exactPrompt(): AsyncIterable<unknown> {
  yield {
    type: 'user',
    message: { role: 'user', content: 'exact queued prompt' },
  };
}

describe('Claude legacy stream-json stdin pump', () => {
  it('does not complete the pump until the pending stdin write settles', async () => {
    class DeferredWrite extends EventEmitter {
      destroyed = false;
      writableEnded = false;
      written = '';
      private confirmWrite: (() => void) | null = null;

      write(chunk: string, callback?: (error?: Error | null) => void): boolean {
        this.written += chunk;
        this.confirmWrite = () => callback?.(null);
        return true;
      }

      confirm(): void {
        this.confirmWrite?.();
      }

      end(): void {
        this.writableEnded = true;
      }
    }

    const stdin = new DeferredWrite();
    let completed = false;
    const handoff = streamToStdin(
      exactPrompt(),
      stdin as unknown as NodeJS.WritableStream,
    )
      .then(() => { completed = true; });

    await vi.waitFor(() => {
      expect(stdin.written).toContain('exact queued prompt');
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    stdin.confirm();
    await handoff;
    expect(completed).toBe(true);
  });

  it('rejects a synchronous stdin write failure', async () => {
    class PreWriteFailure extends EventEmitter {
      destroyed = false;
      writableEnded = false;

      write(): boolean {
        throw Object.assign(new Error('stdin unavailable before write'), { code: 'EBADF' });
      }

      end(): void {
        this.writableEnded = true;
      }
    }

    await expect(streamToStdin(
      exactPrompt(),
      new PreWriteFailure() as unknown as NodeJS.WritableStream,
    )).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('rejects when stdin emits an error during a pending write', async () => {
    class AmbiguousWrite extends EventEmitter {
      destroyed = false;
      writableEnded = false;

      write(): boolean {
        this.emit('error', Object.assign(new Error('write EPIPE after attempt'), { code: 'EPIPE' }));
        return true;
      }

      end(): void {
        this.writableEnded = true;
      }
    }

    await expect(streamToStdin(
      exactPrompt(),
      new AmbiguousWrite() as unknown as NodeJS.WritableStream,
    )).rejects.toMatchObject({ code: 'EPIPE' });
  });
});
