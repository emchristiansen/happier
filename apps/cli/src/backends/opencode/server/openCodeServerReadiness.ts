// V2 preview exposes /api/health; released OpenCode 2.0.15 exposes /api/info
// instead. Both are authenticated when the server has a password.
export const OPEN_CODE_V2_READINESS_PATHS = ['/api/health', '/api/info'] as const;
export const OPEN_CODE_AUTO_READINESS_PATHS = [...OPEN_CODE_V2_READINESS_PATHS, '/global/health'] as const;

export function isOpenCodeServerReadyResponse(path: string, body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  if (path === '/api/info') {
    return typeof value.version === 'string'
      && value.version.length > 0
      && typeof value.pid === 'number'
      && Number.isInteger(value.pid)
      && value.pid >= 0
      && Array.isArray(value.urls)
      && value.paths !== null
      && typeof value.paths === 'object'
      && !Array.isArray(value.paths);
  }
  return value.healthy === true;
}
