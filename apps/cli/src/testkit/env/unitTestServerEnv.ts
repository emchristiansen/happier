/**
 * Default server endpoint for CLI unit tests.
 *
 * `.env.integration-test` points `HAPPIER_SERVER_URL` at `http://localhost:3005`, the port a real
 * Happier server or relay listens on during local development. A unit test that falls back to the
 * configured server would otherwise send real HTTP requests to whatever runs there. Unit test
 * defaults are redirected away from that relay and the cloud endpoints to a loopback URL on the
 * discard port (9), which is expected to be closed in the intended test environment. This changes
 * only the default destination; nothing here controls what listens on port 9 or how a request is
 * routed. A test that needs a specific server sets the variables itself.
 */
export const UNIT_TEST_UNREACHABLE_SERVER_URL = 'http://127.0.0.1:9'

/** Variables that decide where the CLI's API client connects when a test does not set them. */
export const UNIT_TEST_SERVER_URL_ENV_KEYS = [
  'HAPPIER_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
] as const

export function applyUnitTestServerEnv(env: NodeJS.ProcessEnv): void {
  env.HAPPIER_SERVER_URL = UNIT_TEST_UNREACHABLE_SERVER_URL
  env.HAPPIER_WEBAPP_URL = UNIT_TEST_UNREACHABLE_SERVER_URL
  // Either of these would override HAPPIER_SERVER_URL as the canonical or API endpoint.
  delete env.HAPPIER_PUBLIC_SERVER_URL
  delete env.HAPPIER_LOCAL_SERVER_URL
}
