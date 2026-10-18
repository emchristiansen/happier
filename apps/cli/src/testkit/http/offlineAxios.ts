/** A network-free Axios boundary for tests that exercise real CLI orchestration. */
export function createOfflineAxios(read: (url: string) => Promise<unknown>) {
  const refuse = (): never => { throw new Error('Unconfigured offline HTTP operation'); };
  return {
    get(url: string) {
      // Check the origin before dispatching a fixture, even when its path matches.
      if (new URL(url).origin !== 'https://relay.example.invalid') {
        throw new Error(`Offline HTTP boundary refused origin: ${new URL(url).origin}`);
      }
      return read(url);
    },
    request: refuse, create: refuse, post: refuse, put: refuse, patch: refuse,
    delete: refuse, head: refuse, options: refuse,
    // These fixtures throw ordinary Errors; there is no real Axios client or adapter.
    isAxiosError: () => false,
  };
}
