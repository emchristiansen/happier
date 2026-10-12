import {
  spawnSync,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithBufferEncoding,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';

/** Background probes and service commands never create a Windows console. */
export function spawnBackgroundSync(command: string, args: readonly string[], options: Omit<SpawnSyncOptionsWithStringEncoding, 'windowsHide'>): SpawnSyncReturns<string>;
export function spawnBackgroundSync(command: string, args: readonly string[], options?: Omit<SpawnSyncOptionsWithBufferEncoding, 'windowsHide'>): SpawnSyncReturns<Buffer>;
export function spawnBackgroundSync(command: string, args: readonly string[], options: Omit<SpawnSyncOptions, 'windowsHide'>): SpawnSyncReturns<string | Buffer>;
export function spawnBackgroundSync(command: string, args: readonly string[], options: Omit<SpawnSyncOptions, 'windowsHide'> = {}): SpawnSyncReturns<string | Buffer> {
  return spawnSync(command, [...args], { ...options, windowsHide: true });
}
