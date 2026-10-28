import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { vendorBundledPackageRuntimeDependenciesFallback } from './vendorBundledWorkspaceRuntimeDependenciesFallback.mjs';

function stripInternalBundledWorkspaceDependenciesFallback(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([name]) => !String(name).startsWith('@happier-dev/')),
  );
}

function sanitizeBundledPackageJsonFallback(raw) {
  const {
    name,
    version,
    type,
    main,
    module,
    types,
    exports,
    imports,
    dependencies,
    peerDependencies,
    optionalDependencies,
    engines,
  } = raw ?? {};

  // Keep this aligned with `packages/cli-common/src/workspaces/index.ts#sanitizeBundledPackageJson`.
  return {
    name,
    version,
    private: true,
    type,
    main,
    module,
    types,
    exports,
    ...(imports === undefined ? {} : { imports }),
    dependencies: stripInternalBundledWorkspaceDependenciesFallback(dependencies),
    peerDependencies,
    optionalDependencies: stripInternalBundledWorkspaceDependenciesFallback(optionalDependencies),
    engines,
  };
}

function collectPackageJsonRelativeFileTargets(value, result) {
  if (typeof value === 'string') {
    if (value.startsWith('./') && !value.includes('*')) {
      result.add(value.slice(2));
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectPackageJsonRelativeFileTargets(item, result);
    return;
  }
  for (const nested of Object.values(value)) collectPackageJsonRelativeFileTargets(nested, result);
}

function collectExpectedPackageFiles(packageJsonRaw, packageDir, exists) {
  const relativeTargets = new Set();
  collectPackageJsonRelativeFileTargets(packageJsonRaw?.main, relativeTargets);
  collectPackageJsonRelativeFileTargets(packageJsonRaw?.module, relativeTargets);
  collectPackageJsonRelativeFileTargets(packageJsonRaw?.types, relativeTargets);
  collectPackageJsonRelativeFileTargets(packageJsonRaw?.exports, relativeTargets);

  return [...relativeTargets]
    .filter((relativePath) => {
      try {
        return exists(resolve(packageDir, relativePath));
      } catch {
        return false;
      }
    })
	    .sort();
}

function collectRelativeFilePaths(targetDir, relativePrefix = '') {
  const root = String(targetDir ?? '').trim();
  if (!root || !existsSync(root)) return [];

  const relativePaths = [];
  const dirs = [{ absoluteDir: root, relativeDir: String(relativePrefix ?? '').trim() }];
  while (dirs.length > 0) {
    const current = dirs.pop();
    if (!current) continue;
    for (const entry of readdirSync(current.absoluteDir, { withFileTypes: true })) {
      const absolutePath = resolve(current.absoluteDir, entry.name);
      const relativePath = current.relativeDir ? `${current.relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        dirs.push({ absoluteDir: absolutePath, relativeDir: relativePath });
        continue;
      }
      relativePaths.push(relativePath);
    }
  }

  return relativePaths.sort();
}

function collectOwnPackageRelativeFilePaths(packageDir) {
  return collectRelativeFilePaths(packageDir).filter((relativePath) => !relativePath.startsWith('node_modules/'));
}

function collectExternalRuntimeDependencyNames(pkgJson) {
  const names = new Set();
  for (const deps of [pkgJson?.dependencies, pkgJson?.optionalDependencies]) {
    if (!deps || typeof deps !== 'object') continue;
    for (const name of Object.keys(deps)) {
      if (!name.startsWith('@happier-dev/')) {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

function resolveInstalledPackageForRuntimeDependency({ packageName, resolveFromPackageJsonPath }) {
  const normalizedName = String(packageName ?? '').trim();
  const packageJsonPath = String(resolveFromPackageJsonPath ?? '').trim();
  if (!normalizedName || !packageJsonPath) return null;

  const require = createRequire(pathToFileURL(packageJsonPath).href);
  const searchPaths = require.resolve.paths(normalizedName) ?? [];
  let aliasInstalledPackage = null;

  for (const searchPath of searchPaths) {
    const candidatePackageJsonPath = resolve(searchPath, ...normalizedName.split('/'), 'package.json');
    if (!existsSync(candidatePackageJsonPath)) continue;

    const candidatePackageJson = JSON.parse(String(readFileSync(candidatePackageJsonPath, 'utf8')));
    const resolvedPackage = {
      packageDir: dirname(candidatePackageJsonPath),
      packageJsonPath: candidatePackageJsonPath,
      packageJson: candidatePackageJson,
    };
    if (candidatePackageJson?.name === normalizedName) {
      return resolvedPackage;
    }
    if (!aliasInstalledPackage) {
      aliasInstalledPackage = resolvedPackage;
    }
  }

  if (aliasInstalledPackage) {
    return aliasInstalledPackage;
  }

  let resolvedEntry = '';
  try {
    resolvedEntry = require.resolve(`${normalizedName}/package.json`);
  } catch {
    try {
      resolvedEntry = require.resolve(normalizedName);
    } catch {
      return null;
    }
  }

  let dir = dirname(resolvedEntry);
  for (let i = 0; i < 50; i += 1) {
    const candidatePackageJsonPath = resolve(dir, 'package.json');
    if (existsSync(candidatePackageJsonPath)) {
      const candidatePackageJson = JSON.parse(String(readFileSync(candidatePackageJsonPath, 'utf8')));
      if (candidatePackageJson?.name === normalizedName) {
        return {
          packageDir: dir,
          packageJsonPath: candidatePackageJsonPath,
          packageJson: candidatePackageJson,
        };
      }
    }

    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

function packageJsonFilesMatch(sourcePackageJsonPath, destPackageJsonPath) {
  try {
    const source = JSON.parse(String(readFileSync(sourcePackageJsonPath, 'utf8')));
    const dest = JSON.parse(String(readFileSync(destPackageJsonPath, 'utf8')));
    return JSON.stringify(source) === JSON.stringify(dest);
  } catch {
    return false;
  }
}

function filesMatch(sourcePath, destPath) {
  try {
    const source = readFileSync(sourcePath);
    const dest = readFileSync(destPath);
    return Buffer.isBuffer(source) && Buffer.isBuffer(dest) && source.equals(dest);
  } catch {
    return false;
  }
}

function runtimeDependencyTreeMatchesSource({
  packageName,
  resolveFromPackageJsonPath,
  destNodeModulesDir,
  visited = new Set(),
}) {
  const normalizedName = String(packageName ?? '').trim();
  const normalizedDestNodeModulesDir = String(destNodeModulesDir ?? '').trim();
  const visitKey = `${normalizedName}:${normalizedDestNodeModulesDir}`;
  if (!normalizedName || !normalizedDestNodeModulesDir || visited.has(visitKey)) {
    return true;
  }
  visited.add(visitKey);

  const sourcePackage = resolveInstalledPackageForRuntimeDependency({
    packageName: normalizedName,
    resolveFromPackageJsonPath,
  });
  if (!sourcePackage) return false;

  const destPackageDir = resolve(normalizedDestNodeModulesDir, ...normalizedName.split('/'));
  const destPackageJsonPath = resolve(destPackageDir, 'package.json');
  if (!existsSync(destPackageJsonPath)) {
    return false;
  }
  if (!packageJsonFilesMatch(sourcePackage.packageJsonPath, destPackageJsonPath)) {
    return false;
  }

  for (const relativePath of collectOwnPackageRelativeFilePaths(sourcePackage.packageDir)) {
    const sourcePath = resolve(sourcePackage.packageDir, relativePath);
    const destPath = resolve(destPackageDir, relativePath);
    if (!existsSync(destPath) || !filesMatch(sourcePath, destPath)) {
      return false;
    }
  }

  for (const dependencyName of collectExternalRuntimeDependencyNames(sourcePackage.packageJson)) {
    if (!runtimeDependencyTreeMatchesSource({
      packageName: dependencyName,
      resolveFromPackageJsonPath: sourcePackage.packageJsonPath,
      destNodeModulesDir: resolve(destPackageDir, 'node_modules'),
      visited,
    })) {
      return false;
    }
  }

  return true;
}

function bundledRuntimeDependenciesMatchSource({ srcPackageJsonPath, packageJsonRaw, destPackageDir }) {
  const destNodeModulesDir = resolve(destPackageDir, 'node_modules');
  for (const dependencyName of collectExternalRuntimeDependencyNames(packageJsonRaw)) {
    if (!runtimeDependencyTreeMatchesSource({
      packageName: dependencyName,
      resolveFromPackageJsonPath: srcPackageJsonPath,
      destNodeModulesDir,
    })) {
      return false;
    }
  }
  return true;
}

function syncBundledWorkspaceReferencedFiles({ srcPackageDir, destPackageDir, packageJsonRaw, fsOps = {} }) {
  const exists = fsOps.existsSync ?? existsSync;
  const cp = fsOps.cpSync ?? cpSync;
  const mkdir = fsOps.mkdirSync ?? mkdirSync;
  const stat = fsOps.statSync ?? statSync;

  const relativeTargets = new Set();
  collectPackageJsonRelativeFileTargets(packageJsonRaw?.main, relativeTargets);
  collectPackageJsonRelativeFileTargets(packageJsonRaw?.module, relativeTargets);
  collectPackageJsonRelativeFileTargets(packageJsonRaw?.types, relativeTargets);
  collectPackageJsonRelativeFileTargets(packageJsonRaw?.exports, relativeTargets);
  collectPackageJsonRelativeFileTargets(packageJsonRaw?.imports, relativeTargets);

  for (const relPath of relativeTargets) {
    // `dist/**` is synced separately with extra staging/atomicity; skip it here.
    if (relPath.startsWith('dist/')) continue;

    const srcPath = resolve(srcPackageDir, relPath);
    if (!exists(srcPath)) continue;
    const destPath = resolve(destPackageDir, relPath);

    try {
      mkdir(dirname(destPath), { recursive: true });
      const stats = stat(srcPath);
      if (stats.isDirectory()) {
        cp(srcPath, destPath, { recursive: true, force: true });
      } else {
        cp(srcPath, destPath, { force: true });
      }
    } catch {
      // Best-effort: keep local bundled deps usable even if extra file sync fails.
    }
  }
}

let sanitizeBundledPackageJsonImpl = sanitizeBundledPackageJsonFallback;
let readBundledWorkspacePackageNamesImpl = null;
let vendorBundledPackageRuntimeDependenciesImpl = null;

try {
  const mod = await import('../../packages/cli-common/dist/workspaces/index.js');
  if (mod && typeof mod.sanitizeBundledPackageJson === 'function') {
    sanitizeBundledPackageJsonImpl = mod.sanitizeBundledPackageJson;
  }
  if (mod && typeof mod.readBundledWorkspacePackageNames === 'function') {
    readBundledWorkspacePackageNamesImpl = mod.readBundledWorkspacePackageNames;
  }
  if (mod && typeof mod.vendorBundledPackageRuntimeDependencies === 'function') {
    vendorBundledPackageRuntimeDependenciesImpl = mod.vendorBundledPackageRuntimeDependencies;
  }
} catch {
  // Best-effort: local preflight sandboxes may not have `packages/cli-common/dist/**` available.
}

export function sanitizeBundledWorkspacePackageJson(raw) {
  return sanitizeBundledPackageJsonImpl(raw);
}

let syncSequence = 0;
const DEFAULT_STALE_SWAP_DIR_AGE_MS = 60_000;

function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  const buf = new SharedArrayBuffer(4);
  const arr = new Int32Array(buf);
  Atomics.wait(arr, 0, 0, ms);
}

function resolveSyncSwapSuffix(syncId) {
  const explicit = String(syncId ?? '').trim();
  if (explicit) return explicit;

  syncSequence += 1;
  return `${process.pid}.${syncSequence}`;
}

function isRetryableRmError(err) {
  const code = err && typeof err === 'object' ? err.code : null;
  return code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'EINTR';
}

function isStaleSwapDirName(name, targetBaseName) {
  return name.startsWith(`${targetBaseName}.__sync_tmp__.`) || name.startsWith(`${targetBaseName}.__sync_backup__.`);
}

function parseSwapDirOwnerPid(name, targetBaseName) {
  const prefix = `${targetBaseName}.__sync_`;
  if (!name.startsWith(prefix)) return null;

  const suffix = name.slice(prefix.length);
  const firstDot = suffix.indexOf('.');
  if (firstDot < 0) return null;

  const ownerPid = Number(suffix.slice(firstDot + 1).split('.')[0]);
  return Number.isFinite(ownerPid) && ownerPid > 1 ? ownerPid : null;
}

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shouldRemoveSwapDir(entryPath, entryName, targetBaseName, fsOps, options = {}) {
  const stat = fsOps.statSync ?? statSync;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const staleSwapDirAgeMs =
    Number.isFinite(options.staleSwapDirAgeMs) && options.staleSwapDirAgeMs >= 0
      ? options.staleSwapDirAgeMs
      : DEFAULT_STALE_SWAP_DIR_AGE_MS;

  let stats;
  try {
    stats = stat(entryPath);
  } catch {
    return false;
  }

  const ageMs = Math.max(0, nowMs - Number(stats?.mtimeMs ?? 0));
  const ownerPid = parseSwapDirOwnerPid(entryName, targetBaseName);
  if (ownerPid) {
    if (!isPidAlive(ownerPid)) return true;
    return ageMs > staleSwapDirAgeMs;
  }

  return ageMs > staleSwapDirAgeMs;
}

function removeStaleBundledWorkspaceSwapDirs(parentDir, targetBaseName, fsOps, options = {}) {
  const dir = String(parentDir ?? '').trim();
  const baseName = String(targetBaseName ?? '').trim();
  if (!dir || !baseName || !fsOps.existsSync(dir)) return;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!isStaleSwapDirName(entry.name, baseName)) continue;
    const entryPath = resolve(dir, entry.name);
    if (!shouldRemoveSwapDir(entryPath, entry.name, baseName, fsOps, options)) continue;
    rmDirSafeSync(entryPath, fsOps);
  }
}

function readBundledWorkspacePackageNamesFromHostPackageJson(raw) {
  if (readBundledWorkspacePackageNamesImpl) {
    try {
      return readBundledWorkspacePackageNamesImpl(raw);
    } catch {
      // Fall through to the local implementation.
    }
  }

  const bundledDependencies = Array.isArray(raw?.bundledDependencies)
    ? raw.bundledDependencies
    : Array.isArray(raw?.bundleDependencies)
      ? raw.bundleDependencies
      : [];

  return bundledDependencies
    .filter((value) => typeof value === 'string' && value.startsWith('@happier-dev/'));
}

function resolveDefaultBundledWorkspacePackageNames(repoRoot, hostApps, readFileImpl = readFileSync) {
  const repo = String(repoRoot ?? '').trim();
  if (!repo) return [];

  const out = new Set();
  for (const hostApp of hostApps) {
    try {
      const hostPackageJsonPath = resolve(repo, 'apps', String(hostApp ?? '').trim(), 'package.json');
      const raw = JSON.parse(readFileImpl(hostPackageJsonPath, 'utf8'));
      for (const packageName of readBundledWorkspacePackageNamesFromHostPackageJson(raw)) {
        const leaf = String(packageName).split('/').pop();
        if (leaf) out.add(leaf);
      }
    } catch {
      // Best-effort: some host apps may not exist in certain sandboxes.
    }
  }
  return [...out];
}

export function rmDirSafeSync(targetDir, fsOps = {}, { retries = 5, delayMs = 25 } = {}) {
  const rm = fsOps.rmSync ?? rmSync;
  const path = String(targetDir ?? '').trim();
  if (!path) return;

  const maxAttempts = Math.max(1, Number.isFinite(retries) ? retries + 1 : 1);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetryableRmError(error) || attempt === maxAttempts - 1) throw error;
      sleepSync(delayMs);
    }
  }
}

function replaceDirFromSourceSync(targetDir, srcDir, fsOps, options = {}) {
  const outDir = String(targetDir ?? '').trim();
  const sourceDir = String(srcDir ?? '').trim();
  if (!outDir || !sourceDir) return;

  const parentDir = dirname(outDir);
  removeStaleBundledWorkspaceSwapDirs(parentDir, basename(outDir), fsOps, options);
  const suffix = resolveSyncSwapSuffix(options.syncSuffix);
  const stagingDir = `${outDir}.__sync_tmp__.${suffix}`;
  const backupDir = `${outDir}.__sync_backup__.${suffix}`;

  fsOps.mkdirSync(parentDir, { recursive: true });
  rmDirSafeSync(stagingDir, fsOps);
  rmDirSafeSync(backupDir, fsOps);
  fsOps.cpSync(sourceDir, stagingDir, { recursive: true, force: true });

  let movedExistingDir = false;
  try {
    if (fsOps.existsSync(outDir)) {
      fsOps.renameSync(outDir, backupDir);
      movedExistingDir = true;
    }

    fsOps.renameSync(stagingDir, outDir);

    if (movedExistingDir) {
      rmDirSafeSync(backupDir, fsOps);
    }
  } catch (error) {
    rmDirSafeSync(stagingDir, fsOps);
    if (movedExistingDir && fsOps.existsSync(backupDir) && !fsOps.existsSync(outDir)) {
      fsOps.renameSync(backupDir, outDir);
    }
    throw error;
  }
}

function hasCustomFsOps(opts) {
  return [
    'existsSync',
    'cpSync',
    'mkdirSync',
    'renameSync',
    'rmSync',
    'readFileSync',
    'writeFileSync',
  ].some((key) => typeof opts?.[key] === 'function');
}

function resolveRuntimeDependencyVendor(opts) {
  if (typeof opts?.vendorBundledPackageRuntimeDependencies === 'function') {
    return opts.vendorBundledPackageRuntimeDependencies;
  }
  if (hasCustomFsOps(opts)) {
    return null;
  }
  return vendorBundledPackageRuntimeDependenciesImpl ?? vendorBundledPackageRuntimeDependenciesFallback;
}

export function syncBundledWorkspacePackages(opts = {}) {
  const repoRoot = String(opts.repoRoot ?? '').trim();
  if (!repoRoot) return;

  const exists = opts.existsSync ?? existsSync;
  const cp = opts.cpSync ?? cpSync;
  const mkdir = opts.mkdirSync ?? mkdirSync;
  const rename = opts.renameSync ?? renameSync;
  const rm = opts.rmSync ?? rmSync;
  const readFile = opts.readFileSync ?? readFileSync;
  const writeFile = opts.writeFileSync ?? writeFileSync;
  const syncId = opts.syncId;
  const replaceExisting = opts.replaceExisting !== false;
  const hostApps = Array.isArray(opts.hostApps) && opts.hostApps.length > 0
    ? opts.hostApps
    : ['cli', 'stack'];
  const packages = Array.isArray(opts.packages) && opts.packages.length > 0
    ? opts.packages
    : resolveDefaultBundledWorkspacePackageNames(repoRoot, hostApps, readFile);
  const vendorRuntimeDependencies = resolveRuntimeDependencyVendor(opts);

  for (const pkg of packages) {
    const srcDist = resolve(repoRoot, 'packages', pkg, 'dist');
    const srcPackageJsonPath = resolve(repoRoot, 'packages', pkg, 'package.json');
    if (!exists(srcPackageJsonPath)) continue;
    let rawPackageJson = null;
    try {
      rawPackageJson = JSON.parse(readFile(srcPackageJsonPath, 'utf8'));
    } catch {
      // Keep the old best-effort behavior for dist syncing and let package.json syncing skip below.
    }

    for (const hostApp of hostApps) {
      const destPackageDir = resolve(repoRoot, 'apps', hostApp, 'node_modules', '@happier-dev', pkg);
      const destDist = resolve(destPackageDir, 'dist');
      if (exists(srcDist)) {
        try {
          if (!replaceExisting && exists(destDist)) {
            // Preflight mode: keep the `dist/**` directory stable once it exists.
            // Copy into place instead of swapping the directory out from under other processes.
            //
            // Note: this does *not* delete removed files; full refresh/prepack still uses the staged
            // swap path below. Preflight must nevertheless refresh existing files so stack/CLI
            // wrappers do not keep consuming stale bundled workspace code.
            mkdir(destDist, { recursive: true });
            cp(srcDist, destDist, { recursive: true, force: true });
          } else {
            replaceDirFromSourceSync(destDist, srcDist, {
              existsSync: exists,
              cpSync: cp,
              mkdirSync: mkdir,
              renameSync: rename,
              rmSync: rm,
            }, {
              syncSuffix: syncId,
              staleSwapDirAgeMs: opts.staleSwapDirAgeMs,
              nowMs: opts.nowMs,
              isPidAlive: opts.isPidAlive,
            });
          }
        } catch {
          // Best-effort: bundled deps may be missing or readonly.
        }
      }

      const destPackageJsonPath = resolve(destPackageDir, 'package.json');
      try {
        mkdir(destPackageDir, { recursive: true });
        if (!rawPackageJson) continue;
        const sanitized = sanitizeBundledWorkspacePackageJson(rawPackageJson);
        writeFile(destPackageJsonPath, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
        syncBundledWorkspaceReferencedFiles({
          srcPackageDir: dirname(srcPackageJsonPath),
          destPackageDir,
          packageJsonRaw: rawPackageJson,
          fsOps: { existsSync: exists, cpSync: cp, mkdirSync: mkdir, statSync },
        });
      } catch {
        // Best-effort: keep local bundled deps usable even if package.json sync fails.
      }

      if (vendorRuntimeDependencies) {
        if (
          replaceExisting
          || !rawPackageJson
          || !bundledRuntimeDependenciesMatchSource({
            srcPackageJsonPath,
            packageJsonRaw: rawPackageJson,
            destPackageDir,
          })
        ) {
          vendorRuntimeDependencies({
            srcPackageJsonPath,
            resolveFromPackageJsonPath: srcPackageJsonPath,
            destPackageDir,
          });
        }
      }
    }
  }
}
