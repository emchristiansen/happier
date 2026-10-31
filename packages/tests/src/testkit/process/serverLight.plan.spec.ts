import { createRequire, syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasServerSharedDepsOutputs,
  hasServerGeneratedProviderOutputs,
  ensureServerGeneratedProviderOutputs,
  resolveServerLightSqliteDatabaseUrl,
  resolveServerStartLaunchSpec,
  shouldRetryServerStartFromFailureContext,
  resolveSharedDepsBuildArgs,
  resolveTestDbProvider,
  resolveMigrateCommandArgs,
  resolveStartCommandArgs,
  shouldUseServerSourceEntrypoint,
  withServerSharedDepsBuildLock,
  type TestDbProvider,
} from "./serverLight";
import { resolveServerAppWorkspaceName } from "./serverWorkspaceName";


const lockBoundary = vi.hoisted(() => ({ onCreate: null as null | ((path: string) => void), calls: 0 }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  // Node overloads are interposed only at this genuine filesystem boundary.
  return { ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      if (args[1] === 'wx') lockBoundary.onCreate?.(String(args[0]));
      return fd;
    },
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      actual.linkSync(...args); lockBoundary.onCreate?.(String(args[1]));
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (/^\/proc\/\d+\/stat$/.test(String(args[0]))) return `1 (fixture) S ${Array(18).fill('0').join(' ')} 100`;
      return actual.readFileSync(...args);
    },
  };
});
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const refuse = () => { lockBoundary.calls++; throw new Error('child process forbidden'); };
  return { ...actual, spawn: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, execFile: refuse, execFileSync: refuse, fork: refuse };
});

const normalizeForPathAssertions = (value: string): string => value.replace(/\\/g, "/");

describe("startServerLight planning helpers", () => {
  it("defaults to pglite when HAPPIER_E2E_DB_PROVIDER is unset", () => {
    expect(resolveTestDbProvider({})).toBe("pglite");
  });

  it("accepts sqlite via HAPPIER_E2E_DB_PROVIDER", () => {
    expect(resolveTestDbProvider({ HAPPIER_E2E_DB_PROVIDER: "sqlite" })).toBe("sqlite");
  });

  it("accepts postgres via HAPPIER_E2E_DB_PROVIDER", () => {
    expect(resolveTestDbProvider({ HAPPIER_E2E_DB_PROVIDER: "postgres" })).toBe("postgres");
    expect(resolveTestDbProvider({ HAPPIER_E2E_DB_PROVIDER: "postgresql" })).toBe("postgres");
  });

  it("accepts mysql via HAPPIER_E2E_DB_PROVIDER", () => {
    expect(resolveTestDbProvider({ HAPPIER_E2E_DB_PROVIDER: "mysql" })).toBe("mysql");
  });

  it.each<[TestDbProvider, string]>([
    ["pglite", "start:light"],
    ["sqlite", "start:light"],
    ["postgres", "start"],
    ["mysql", "start"],
  ])("uses the expected start command for %s", (provider, expectedScript) => {
    expect(resolveStartCommandArgs(provider)).toEqual(["-s", "workspace", resolveServerAppWorkspaceName(), expectedScript]);
  });

  it("pins TSX_TSCONFIG_PATH for workspace-driven server launches", () => {
    const launch = resolveServerStartLaunchSpec({
      provider: "sqlite",
      env: {},
    });

    expect(launch.command).toMatch(/yarn(?:\.cmd)?$/);
    expect(launch.args).toEqual(["-s", "workspace", resolveServerAppWorkspaceName(), "start:light"]);
    expect(launch.cwd.length).toBeGreaterThan(0);
    expect(launch.env).toMatchObject({
      TSX_TSCONFIG_PATH: expect.stringContaining("tsconfig.json"),
    });
    const tsconfigPath = launch.env?.TSX_TSCONFIG_PATH;
    expect(tsconfigPath).toBeDefined();
    expect(normalizeForPathAssertions(tsconfigPath ?? "")).toContain("/apps/server/tsconfig.json");
  });

  it("launches through the production light migration-plan owner when requested", () => {
    const launch = resolveServerStartLaunchSpec({
      provider: "sqlite",
      env: { HAPPIER_STACK_MIGRATE_MODE: "skip" },
      useDevLightMigrationOwner: true,
    });

    expect(launch.args).toEqual(["-s", "workspace", resolveServerAppWorkspaceName(), "dev:light"]);
  });

  it.each<[TestDbProvider, string]>([
    ["pglite", "migrate:light:deploy"],
    ["sqlite", "migrate:sqlite:deploy"],
    ["postgres", "prisma migrate deploy"],
    ["mysql", "migrate:mysql:deploy"],
  ])("uses the expected migration command for %s", (provider, expected) => {
    const args = resolveMigrateCommandArgs(provider).join(" ");
    expect(args).toContain(expected);
  });

  it("builds shared server dependencies before startup", () => {
    expect(resolveSharedDepsBuildArgs()).toEqual(["-s", "workspace", resolveServerAppWorkspaceName(), "build:shared"]);
  });

  it("generates canonical SQLite DATABASE_URL params while preserving explicit DATABASE_URL", () => {
    const generated = resolveServerLightSqliteDatabaseUrl({
      dataDir: "/tmp/happier-e2e",
      env: {},
      platform: "linux",
    });
    expect(generated).toBe("file:/tmp/happier-e2e/happier-server-light.sqlite?socket_timeout=30&connection_limit=1");

    const explicitDatabaseUrl = "file:/tmp/custom-happier.sqlite?mode=rw";
    expect(resolveServerLightSqliteDatabaseUrl({
      dataDir: "/tmp/happier-e2e",
      env: { DATABASE_URL: explicitDatabaseUrl },
      platform: "linux",
    })).toBe(explicitDatabaseUrl);
  });

  it("ignores an inherited external DATABASE_URL for an explicitly selected SQLite server", () => {
    expect(resolveServerLightSqliteDatabaseUrl({
      dataDir: "/tmp/happier-e2e",
      env: { DATABASE_URL: "postgresql://postgres@127.0.0.1:5432/happier" },
      platform: "linux",
      inheritDatabaseUrl: false,
    })).toBe("file:/tmp/happier-e2e/happier-server-light.sqlite?socket_timeout=30&connection_limit=1");
  });

  it("serializes shared deps builds across concurrent callers", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "happier-server-shared-deps-lock-"));
    const lockPath = resolve(rootDir, "server-shared-deps-build.lock");
    let releaseFirst = () => {};
    let secondEntered = false;

    const first = withServerSharedDepsBuildLock(
      async () =>
        await new Promise<void>((resolveFirst) => {
          releaseFirst = resolveFirst;
        }),
      {
        lockPath,
        timeoutMs: 5_000,
        pollIntervalMs: 10,
        staleAfterMs: 5_000,
      },
    );

    const second = withServerSharedDepsBuildLock(
      async () => {
        secondEntered = true;
      },
      {
        lockPath,
        timeoutMs: 5_000,
        pollIntervalMs: 10,
        staleAfterMs: 5_000,
      },
    );

    await sleep(50);
    expect(secondEntered).toBe(false);
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(secondEntered).toBe(true);
  });

	  it("detects when shared server dependency outputs already exist", () => {
	    const rootDir = mkdtempSync(join(tmpdir(), "happier-server-shared-deps-"));
	    expect(hasServerSharedDepsOutputs(rootDir)).toBe(false);

	    mkdirSync(resolve(rootDir, "packages", "agents", "dist"), { recursive: true });
	    writeFileSync(resolve(rootDir, "packages", "agents", "dist", "index.js"), "export {};\n", "utf8");
	    expect(hasServerSharedDepsOutputs(rootDir)).toBe(false);

	    mkdirSync(resolve(rootDir, "packages", "protocol", "dist"), { recursive: true });
	    writeFileSync(resolve(rootDir, "packages", "protocol", "dist", "index.js"), "export {};\n", "utf8");
	    expect(hasServerSharedDepsOutputs(rootDir)).toBe(false);

	    mkdirSync(resolve(rootDir, "packages", "cli-common", "dist", "tailscale"), { recursive: true });
	    writeFileSync(resolve(rootDir, "packages", "cli-common", "dist", "tailscale", "index.js"), "export {};\n", "utf8");
	    expect(hasServerSharedDepsOutputs(rootDir)).toBe(true);
	  });

  it("detects when generated provider outputs are current", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "happier-server-generated-"));
    expect(hasServerGeneratedProviderOutputs(rootDir, "sqlite")).toBe(false);

    mkdirSync(resolve(rootDir, "apps", "server", "prisma", "sqlite"), { recursive: true });
    mkdirSync(resolve(rootDir, "apps", "server", "prisma", "mysql"), { recursive: true });
    mkdirSync(resolve(rootDir, "apps", "server", "generated", "sqlite-client"), { recursive: true });
    mkdirSync(resolve(rootDir, "apps", "server", "generated", "mysql-client"), { recursive: true });
    mkdirSync(resolve(rootDir, "node_modules", ".prisma", "client"), { recursive: true });

    writeFileSync(resolve(rootDir, "apps", "server", "prisma", "schema.prisma"), "datasource db { provider = \"postgresql\" }\n", "utf8");
    writeFileSync(resolve(rootDir, "apps", "server", "prisma", "sqlite", "schema.prisma"), "datasource db { provider = \"sqlite\" }\n", "utf8");
    writeFileSync(
      resolve(rootDir, "apps", "server", "prisma", "mysql", "schema.prisma"),
      [
        "datasource db { provider = \"mysql\" }",
        "model PublicSessionShare {",
        "  id String @id",
        "  tokenHash Bytes @db.VarBinary(32) @unique",
        "  @@index([id])",
        "  @@unique([tokenHash])",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(resolve(rootDir, "apps", "server", "generated", "sqlite-client", "index.js"), "export {};\n", "utf8");
    writeFileSync(resolve(rootDir, "apps", "server", "generated", "mysql-client", "index.js"), "export {};\n", "utf8");
    writeFileSync(resolve(rootDir, "node_modules", ".prisma", "client", "default.js"), "module.exports={};\n", "utf8");

    writeFileSync(resolve(rootDir, "apps", "server", "generated", "sqlite-client", "schema.prisma"), "datasource db { provider = \"sqlite\" }\n", "utf8");
    writeFileSync(
      resolve(rootDir, "apps", "server", "generated", "mysql-client", "schema.prisma"),
      [
        "datasource db { provider = \"mysql\" }",
        "model PublicSessionShare {",
        "  id String @id",
        "  tokenHash Bytes @unique @db.VarBinary(32)",
        "  @@unique([tokenHash])",
        "  @@index([id])",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(resolve(rootDir, "node_modules", ".prisma", "client", "schema.prisma"), "datasource db { provider = \"postgresql\" }\n", "utf8");

    expect(hasServerGeneratedProviderOutputs(rootDir, "pglite")).toBe(true);
    expect(hasServerGeneratedProviderOutputs(rootDir, "sqlite")).toBe(true);
    expect(hasServerGeneratedProviderOutputs(rootDir, "mysql")).toBe(true);

    writeFileSync(resolve(rootDir, "apps", "server", "generated", "mysql-client", "schema.prisma"), "stale mysql\n", "utf8");
    expect(hasServerGeneratedProviderOutputs(rootDir, "sqlite")).toBe(true);
    expect(hasServerGeneratedProviderOutputs(rootDir, "mysql")).toBe(false);

    writeFileSync(resolve(rootDir, "apps", "server", "prisma", "sqlite", "schema.prisma"), "changed\n", "utf8");
    expect(hasServerGeneratedProviderOutputs(rootDir, "pglite")).toBe(true);
    expect(hasServerGeneratedProviderOutputs(rootDir, "sqlite")).toBe(false);
  });

  it("serializes generation and rechecks each requested provider", async () => {
    const generated = new Set<TestDbProvider>();
    const calls: TestDbProvider[] = [];
    const generate = async (provider: TestDbProvider) => {
      calls.push(provider);
      await sleep(10);
      generated.add(provider);
    };

    await Promise.all([
      ensureServerGeneratedProviderOutputs({
        dbProvider: "sqlite",
        hasOutputs: (provider) => generated.has(provider),
        generate,
      }),
      ensureServerGeneratedProviderOutputs({
        dbProvider: "postgres",
        hasOutputs: (provider) => generated.has(provider),
        generate,
      }),
    ]);

    expect(calls).toEqual(["sqlite", "postgres"]);
    expect(generated).toEqual(new Set<TestDbProvider>(["sqlite", "postgres"]));
  });

  it("retries server start when startup failure tail contains EADDRINUSE", () => {
    const retry = shouldRetryServerStartFromFailureContext({
      attempt: 1,
      maxAttempts: 5,
      preflightPortAvailable: true,
      error: new Error("server-light exited before /health was ready (code=1)"),
      stderrTail: "Error: listen EADDRINUSE: address already in use 127.0.0.1:58786",
      stdoutTail: "",
    });
    expect(retry).toBe(true);
  });

  it("retries server start when auth initialization stalls before health is ready", () => {
    const retry = shouldRetryServerStartFromFailureContext({
      attempt: 1,
      maxAttempts: 5,
      preflightPortAvailable: true,
      error: new Error("Timed out waiting for /health at http://127.0.0.1:50133 | lastStatus=none | lastBodyStatus=none | lastError=fetch failed"),
      stderrTail: "",
      stdoutTail: "[16:04:06.479] INFO: Initializing auth module...",
    });
    expect(retry).toBe(true);
  });

  it("supports explicit server source-entrypoint mode flags", () => {
    expect(shouldUseServerSourceEntrypoint({})).toBe(false);
    expect(shouldUseServerSourceEntrypoint({ HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: "1" })).toBe(true);
    expect(shouldUseServerSourceEntrypoint({ HAPPY_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: "yes" })).toBe(true);
  });

  it.each<[
    TestDbProvider,
    string,
  ]>([
    ["sqlite", "main.light.ts"],
    ["pglite", "main.light.ts"],
    ["postgres", "main.ts"],
  ])("uses the direct server source entrypoint for %s when enabled", (provider, expectedEntrypoint) => {
    const launch = resolveServerStartLaunchSpec({
      provider,
      env: { HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: "1" },
    });

    expect(launch.command).toBe(process.execPath);
    expect(normalizeForPathAssertions(launch.cwd)).toContain(`/apps/server`);
    expect(launch.args).toEqual(
      expect.arrayContaining([
        "--import",
        expect.stringContaining("tsx/dist/esm/index.mjs"),
        expect.stringContaining(expectedEntrypoint),
      ]),
    );
    expect(launch.env).toMatchObject({
      TSX_TSCONFIG_PATH: expect.stringContaining("tsconfig.json"),
    });
    const tsconfigPath = launch.env?.TSX_TSCONFIG_PATH;
    expect(tsconfigPath).toBeDefined();
    expect(normalizeForPathAssertions(tsconfigPath ?? "")).toContain("/apps/server/tsconfig.json");
  });
});

describe('J079 server lock ownership', () => {
  let root: string;
  let restoreNativeBoundaries: (() => void) | undefined;
  beforeEach(async () => {
    // Also bind actual builtin exports: linked .mjs dependencies may be externalized by Vite.
    const require = createRequire(import.meta.url);
    const nativeFs: typeof import('node:fs') = require('node:fs');
    const nativeCp: typeof import('node:child_process') = require('node:child_process');
    const savedRead = nativeFs.readFileSync;
    const savedSpawn = nativeCp.spawnSync;
    nativeFs.readFileSync = ((...args: Parameters<typeof savedRead>) => {
      if (/^\/proc\/\d+\/stat$/.test(String(args[0]))) return `1 (fixture) S ${Array(18).fill('0').join(' ')} 100`;
      return savedRead(...args);
    }) as typeof savedRead; // Genuine overloaded builtin boundary.
    nativeCp.spawnSync = (() => { throw new Error('J079 external probe forbidden'); }) as typeof savedSpawn;
    syncBuiltinESMExports();
    expect(require('node:fs').readFileSync).toBe(nativeFs.readFileSync);
    expect(require('node:child_process').spawnSync).toBe(nativeCp.spawnSync);
    restoreNativeBoundaries = () => { nativeFs.readFileSync = savedRead; nativeCp.spawnSync = savedSpawn; syncBuiltinESMExports(); };

    root = mkdtempSync(join(tmpdir(), 'j079-server-'));
    const fs = await import('node:fs');
    const cp = await import('node:child_process');
    expect(fs.openSync.toString()).toContain('lockBoundary');
    expect(cp.spawnSync.toString()).toContain('forbidden');
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(signal).toBe(0);
      if (pid === process.pid) return true;
      throw Object.assign(new Error('fixture absent'), { code: 'ESRCH' });
    });
    vi.stubGlobal('fetch', () => { lockBoundary.calls++; throw new Error('fetch forbidden'); });
  });
  afterEach(() => {
    lockBoundary.onCreate = null;
    expect(lockBoundary.calls).toBe(0);
    restoreNativeBoundaries?.();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true });
  });
  it('preserves an empty legacy record and refuses callback', async () => {
    const lockPath = join(root, 'lock'); writeFileSync(lockPath, '');
    await expect(withServerSharedDepsBuildLock(async () => { throw new Error('empty entered'); }, {
      lockPath, timeoutMs: 15, pollIntervalMs: 1,
    })).rejects.toThrow(/Timed out/);
    expect(readFileSync(lockPath, 'utf8')).toBe('');
  });
  it('recovers a positively absent recorded owner', async () => {
    const lockPath = join(root, 'lock'); writeFileSync(lockPath, JSON.stringify({ pid: 999999999, token: 'fixture-dead', createdAtMs: 1 }));
    await expect(withServerSharedDepsBuildLock(async () => 'owned', { lockPath, timeoutMs: 100, pollIntervalMs: 1 })).resolves.toBe('owned');
    expect(existsSync(lockPath)).toBe(false);
  });
  it('preserves a replacement record on release', async () => {
    const lockPath = join(root, 'lock'); const replacement = JSON.stringify({ pid: process.pid, token: 'new-owner', createdAtMs: Date.now() });
    await withServerSharedDepsBuildLock(async () => { unlinkSync(lockPath); writeFileSync(lockPath, replacement); }, { lockPath });
    expect(readFileSync(lockPath, 'utf8')).toBe(replacement);
  });
  it('serializes a contender at canonical publication', async () => {
    const lockPath = join(root, 'lock'); const events: string[] = []; let second: Promise<void> | undefined;
    lockBoundary.onCreate = (path) => {
      if (path !== lockPath || second) return;
      lockBoundary.onCreate = null;
      second = withServerSharedDepsBuildLock(async () => { events.push('second'); }, { lockPath, timeoutMs: 500, pollIntervalMs: 1 });
    };
    try {
      await withServerSharedDepsBuildLock(async () => { events.push('first'); }, { lockPath, timeoutMs: 500, pollIntervalMs: 1 });
      await second; expect(events).toEqual(['first', 'second']);
    } finally { lockBoundary.onCreate = null; await second; }
  });
});
