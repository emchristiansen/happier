import {
  Dirent, chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  statSync, symlinkSync, utimesSync, writeFileSync, writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';

type CopyMissingEntryOptions = {
  mergeExistingDirectoryContents?: boolean;
  pruneNestedNodeModules?: boolean;
};

function isTransientSyncDirName(name: string): boolean {
  return name.startsWith('dist.__sync_tmp__.') || name.startsWith('dist.__sync_backup__.');
}

function resolveSymlinkType(sourcePath: string): 'dir' | 'file' | 'junction' | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    return lstatSync(sourcePath).isDirectory() ? 'junction' : 'file';
  } catch {
    return undefined;
  }
}

function ensureSymlink(destPath: string, sourcePath: string): void {
  if (existsSync(destPath)) return;
  mkdirSync(dirname(destPath), { recursive: true });
  try {
    symlinkSync(sourcePath, destPath, resolveSymlinkType(sourcePath));
  } catch {
    // Best-effort only. Some environments disallow symlinks; callers must tolerate missing links.
  }
}

function isDirectoryEntry(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

const BYTE_COPY_CHUNK_SIZE = 1 << 20;

/**
 * Dereferencing copy of one missing entry (the `cpSync(src, dest, { recursive, dereference, preserveTimestamps })` contract)
 * using plain reads and writes. File copies through copy_file_range/FICLONE may block synchronously until freshly written
 * source data is committed on block-cloning filesystems, stalling the caller's event loop for seconds per file.
 */
function copyEntryBytesSync(sourcePath: string, destPath: string): void {
  const stat = statSync(sourcePath);
  if (stat.isDirectory()) {
    mkdirSync(destPath, { recursive: true });
    for (const name of readdirSync(sourcePath)) copyEntryBytesSync(resolve(sourcePath, name), resolve(destPath, name));
    chmodSync(destPath, stat.mode & 0o7777);
    utimesSync(destPath, stat.atime, stat.mtime);
    return;
  }
  if (!stat.isFile()) throw new Error(`Cannot copy non-regular file into CLI snapshot: ${sourcePath}`);
  const input = openSync(sourcePath, 'r');
  try {
    const output = openSync(destPath, 'wx', 0o600);
    try {
      const buffer = Buffer.allocUnsafe(BYTE_COPY_CHUNK_SIZE);
      for (let read = readSync(input, buffer, 0, buffer.length, null); read > 0; read = readSync(input, buffer, 0, buffer.length, null)) {
        for (let written = 0; written < read;) written += writeSync(output, buffer, written, read - written);
      }
    } finally {
      closeSync(output);
    }
  } finally {
    closeSync(input);
  }
  chmodSync(destPath, stat.mode & 0o7777);
  utimesSync(destPath, stat.atime, stat.mtime);
}

function copyMissingEntry(destPath: string, sourcePath: string, options: CopyMissingEntryOptions = {}): void {
  const mergeExistingDirectoryContents = options.mergeExistingDirectoryContents ?? true;
  const pruneNestedNodeModules = options.pruneNestedNodeModules ?? false;
  if (isTransientSyncDirName(basename(sourcePath))) return;

  if (existsSync(destPath)) {
    if (!isDirectoryEntry(sourcePath) || !isDirectoryEntry(destPath)) return;
    if (!mergeExistingDirectoryContents) return;

    for (const entry of listNodeModulesEntries(sourcePath)) {
      if (entry.name.startsWith('.')) continue;
      if (pruneNestedNodeModules && entry.name === 'node_modules') continue;
      copyMissingEntry(resolve(destPath, entry.name), resolve(sourcePath, entry.name), options);
    }
    return;
  }

  mkdirSync(dirname(destPath), { recursive: true });
  if (isDirectoryEntry(sourcePath)) {
    mkdirSync(destPath, { recursive: true });
    for (const entry of listNodeModulesEntries(sourcePath)) {
      if (entry.name.startsWith('.')) continue;
      if (pruneNestedNodeModules && entry.name === 'node_modules') continue;
      copyMissingEntry(resolve(destPath, entry.name), resolve(sourcePath, entry.name), options);
    }
    return;
  }

  try {
    copyEntryBytesSync(sourcePath, destPath);
  } catch {
    // Best-effort only. Callers must tolerate missing links in constrained environments.
  }
}

function ensureCopiedDirectory(destPath: string, sourcePath: string, options: CopyMissingEntryOptions = {}): void {
  copyMissingEntry(destPath, sourcePath, options);
}

function ensureCopiedDirectoryFromCandidates(
  destPath: string,
  sourceCandidates: ReadonlyArray<string>,
  options: CopyMissingEntryOptions = {},
): void {
  for (const sourcePath of sourceCandidates) {
    if (!existsSync(sourcePath)) continue;
    ensureCopiedDirectory(destPath, sourcePath, options);
  }
}

function ensureCopiedNodeModulesEntries(sourceNodeModulesDir: string, destNodeModulesDir: string, skipNames: ReadonlySet<string> = new Set()): void {
  for (const entry of listNodeModulesEntries(sourceNodeModulesDir)) {
    if (entry.name.startsWith('.')) continue;
    if (skipNames.has(entry.name)) continue;

    const sourcePath = resolve(sourceNodeModulesDir, entry.name);
    const destPath = resolve(destNodeModulesDir, entry.name);
    ensureCopiedDirectory(destPath, sourcePath);
  }
}

function ensureCopiedTextFile(destPath: string, sourcePath: string, options: { overwriteExisting?: boolean } = {}): void {
  if (existsSync(destPath) && !options.overwriteExisting) return;
  mkdirSync(dirname(destPath), { recursive: true });
  try {
    writeFileSync(destPath, readFileSync(sourcePath));
  } catch {
    // Best-effort only. Callers tolerate missing optional files.
  }
}

function listNodeModulesEntries(nodeModulesDir: string): Dirent[] {
  try {
    return readdirSync(nodeModulesDir, { withFileTypes: true }).filter((entry) => !isTransientSyncDirName(entry.name));
  } catch {
    return [];
  }
}

function listScopedPackageEntries(scopeDir: string): Dirent[] {
  return listNodeModulesEntries(scopeDir).filter((entry) => !entry.name.startsWith('.'));
}

type RuntimeDependencyCollectionOptions = {
  includeOptionalDependencies?: boolean;
  includePeerDependencies?: boolean;
};

function collectExternalRuntimeDepNamesFromPackageJson(
  packageJsonPath: string,
  options: RuntimeDependencyCollectionOptions = {},
): ReadonlyArray<{ name: string; optional: boolean }> {
  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return [];
  }

  const includeOptionalDependencies = options.includeOptionalDependencies ?? true;
  const includePeerDependencies = options.includePeerDependencies ?? true;
  const deps = pkg?.dependencies ?? {};
  const optionalDeps = pkg?.optionalDependencies ?? {};
  const peerDeps = pkg?.peerDependencies ?? {};

  const required = Object.keys(deps)
    .filter((name) => typeof name === 'string' && !name.startsWith('@happier-dev/'))
    .map((name) => ({ name, optional: false }));
  const optional = includeOptionalDependencies
    ? Object.keys(optionalDeps)
        .filter((name) => typeof name === 'string' && !name.startsWith('@happier-dev/'))
        .map((name) => ({ name, optional: true }))
    : [];
  const peer = includePeerDependencies
    ? Object.keys(peerDeps)
        .filter((name) => typeof name === 'string' && !name.startsWith('@happier-dev/'))
        .map((name) => ({ name, optional: true }))
    : [];

  return [...required, ...optional, ...peer];
}

function readPackageNameFromPackageJson(packageJsonPath: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: unknown };
    return typeof pkg.name === 'string' && pkg.name.trim() ? pkg.name.trim() : null;
  } catch {
    return null;
  }
}

function ensureWorkspacePackageRuntimeDependencyFallbacks(
  snapshotPackageNodeModulesDir: string,
  rootDir: string,
  packageJsonPath: string,
): void {
  const rootNodeModulesDir = resolve(rootDir, 'node_modules');
  const cliNodeModulesDir = resolve(rootDir, 'apps', 'cli', 'node_modules');

  for (const dep of collectExternalRuntimeDepNamesFromPackageJson(packageJsonPath)) {
    const snapshotDepPath = resolve(snapshotPackageNodeModulesDir, ...dep.name.split('/'));
    const sourceCandidates = [
      resolve(cliNodeModulesDir, ...dep.name.split('/')),
      resolve(rootNodeModulesDir, ...dep.name.split('/')),
    ];
    ensureCopiedDirectoryFromCandidates(snapshotDepPath, sourceCandidates);
  }
}

type PathSemantics = { relative: (from: string, to: string) => string; isAbsolute: (path: string) => boolean; sep: string };

/** Whether `path` lies strictly inside `dir` under the platform's own path semantics (separators, drives, case). */
export function isPathStrictlyInside(dir: string, path: string, semantics: PathSemantics = { relative, isAbsolute, sep }): boolean {
  const fromDir = semantics.relative(dir, path);
  return fromDir !== '' && fromDir !== '..' && !fromDir.startsWith(`..${semantics.sep}`) && !semantics.isAbsolute(fromDir);
}

/**
 * Node-style resolution of the package directory for `name` from `fromDir`, bounded at the repository root:
 * the nearest `<dir>/node_modules/<name>` from `fromDir` up to and including `rootDir`. Nothing above the root is consulted.
 */
function resolvePackageDirWithinRoot(fromDir: string, name: string, rootDir: string): string | null {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    if (basename(dir) !== 'node_modules') {
      const candidate = resolve(dir, 'node_modules', ...name.split('/'));
      if (existsSync(candidate)) return candidate;
    }
    if (dir === rootDir || dirname(dir) === dir) return null;
  }
}

/** The top-level `node_modules` entry (`name` or `@scope/name`) that contains `packageDir`, relative to that directory. */
function topLevelPackagePath(rootNodeModulesDir: string, packageDir: string): string {
  const [first, second] = relative(rootNodeModulesDir, packageDir).split(sep);
  return first.startsWith('@') ? join(first, second) : first;
}

/**
 * The root `node_modules` entries the CLI's declared runtime closure reaches, as paths relative to the root `node_modules`.
 * The walk follows Node's own resolution in the source tree from the CLI package, from the CLI's own third-party
 * packages, and from every root package reached, so each entry is reproduced whole (with its own nested `node_modules`)
 * and every dependency resolves to the same source package instance in the copy. Workspace packages under the CLI's
 * `@happier-dev` scope are supplied separately. Unresolvable optional and peer dependencies, and missing manifests,
 * contribute nothing.
 */
function collectRootRuntimeClosure(rootDir: string): string[] {
  const rootNodeModulesDir = resolve(rootDir, 'node_modules');
  const cliPackageDir = resolve(rootDir, 'apps', 'cli');
  const cliNodeModulesDir = resolve(cliPackageDir, 'node_modules');
  const workspaceScopeDir = resolve(cliNodeModulesDir, '@happier-dev');
  const entries = new Set<string>();
  const visited = new Set<string>();
  const pending = [cliPackageDir];
  for (let from = pending.pop(); from !== undefined; from = pending.pop()) {
    for (const dep of collectExternalRuntimeDepNamesFromPackageJson(resolve(from, 'package.json'))) {
      const packageDir = resolvePackageDirWithinRoot(from, dep.name, rootDir);
      if (!packageDir || visited.has(packageDir)) continue;
      const isRootPackage = isPathStrictlyInside(rootNodeModulesDir, packageDir);
      const isCliLocalPackage = isPathStrictlyInside(cliNodeModulesDir, packageDir) && !isPathStrictlyInside(workspaceScopeDir, packageDir);
      if (!isRootPackage && !isCliLocalPackage) continue;
      visited.add(packageDir);
      if (isRootPackage) entries.add(topLevelPackagePath(rootNodeModulesDir, packageDir));
      pending.push(packageDir);
    }
  }
  return [...entries].sort();
}

/**
 * Reproduce the repository root's position relative to the CLI package: link the CLI's declared root runtime closure into
 * `<rootMirrorDir>/node_modules`, below which the snapshot's CLI package sits at its repository-relative path. Code in the
 * snapshot then resolves the CLI's own `node_modules` first and the root closure second, as in the source tree, and every
 * package instance has exactly one location. Publication detaches the links.
 */
function ensureRootRuntimeClosure(rootMirrorDir: string, rootDir: string): void {
  const rootNodeModulesDir = resolve(rootDir, 'node_modules');
  if (!existsSync(rootNodeModulesDir)) return;
  for (const entry of collectRootRuntimeClosure(rootDir)) {
    ensureSymlink(resolve(rootMirrorDir, 'node_modules', entry), resolve(rootNodeModulesDir, entry));
  }
}

function ensureWorkspacePackageManifests(snapshotNodeModulesDir: string, rootDir: string): void {
  const packagesDir = resolve(rootDir, 'packages');
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const packageJsonPath = resolve(packagesDir, entry.name, 'package.json');
    let packageName = '';
    try {
      const raw = readFileSync(packageJsonPath, 'utf8');
      const parsed = JSON.parse(raw) as { name?: unknown };
      packageName = typeof parsed.name === 'string' ? parsed.name.trim() : '';
    } catch {
      continue;
    }

    if (!packageName.startsWith('@happier-dev/')) continue;

    const scopePackageName = packageName.slice('@happier-dev/'.length).trim();
    if (!scopePackageName) continue;

    const snapshotPackageJsonPath = resolve(snapshotNodeModulesDir, '@happier-dev', scopePackageName, 'package.json');
    ensureCopiedTextFile(snapshotPackageJsonPath, packageJsonPath, { overwriteExisting: true });
  }
}

function collectPackageJsonRelativeFileTargets(value: unknown, result: Set<string>): void {
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

function ensureWorkspacePackageReferencedFiles(snapshotNodeModulesDir: string, rootDir: string): void {
  const packagesDir = resolve(rootDir, 'packages');
  for (const entry of listNodeModulesEntries(packagesDir)) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const sourcePackageDir = resolve(packagesDir, entry.name);
    const packageJsonPath = resolve(sourcePackageDir, 'package.json');
    let packageJson: Record<string, unknown>;
    try {
      packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }

    const packageName = typeof packageJson.name === 'string' ? packageJson.name.trim() : '';
    if (!packageName.startsWith('@happier-dev/')) continue;

    const scopePackageName = packageName.slice('@happier-dev/'.length).trim();
    if (!scopePackageName) continue;

    const relativeFileTargets = new Set<string>();
    collectPackageJsonRelativeFileTargets(packageJson.main, relativeFileTargets);
    collectPackageJsonRelativeFileTargets(packageJson.module, relativeFileTargets);
    collectPackageJsonRelativeFileTargets(packageJson.types, relativeFileTargets);
    collectPackageJsonRelativeFileTargets(packageJson.exports, relativeFileTargets);

    const snapshotPackageDir = resolve(snapshotNodeModulesDir, '@happier-dev', scopePackageName);
    for (const relativeFilePath of relativeFileTargets) {
      ensureCopiedTextFile(
        resolve(snapshotPackageDir, relativeFilePath),
        resolve(sourcePackageDir, relativeFilePath),
        { overwriteExisting: true },
      );
    }
  }
}

function ensureWorkspacePackageDistTrees(snapshotNodeModulesDir: string, rootDir: string): void {
  const packagesDir = resolve(rootDir, 'packages');
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const packageJsonPath = resolve(packagesDir, entry.name, 'package.json');
    let packageName = '';
    try {
      const raw = readFileSync(packageJsonPath, 'utf8');
      const parsed = JSON.parse(raw) as { name?: unknown };
      packageName = typeof parsed.name === 'string' ? parsed.name.trim() : '';
    } catch {
      continue;
    }

    if (!packageName.startsWith('@happier-dev/')) continue;

    const scopePackageName = packageName.slice('@happier-dev/'.length).trim();
    if (!scopePackageName) continue;

    const sourceDistDir = resolve(packagesDir, entry.name, 'dist');
    const snapshotPackageDir = resolve(snapshotNodeModulesDir, '@happier-dev', scopePackageName);
    const snapshotDistDir = resolve(snapshotPackageDir, 'dist');
    if (!existsSync(sourceDistDir)) continue;

    mkdirSync(snapshotPackageDir, { recursive: true });
    try {
      cpSync(sourceDistDir, snapshotDistDir, {
        recursive: true,
        dereference: false,
        preserveTimestamps: true,
        force: true,
      });
    } catch {
      // Best-effort only. Callers tolerate missing optional files.
    }
  }
}

function ensureWorkspacePackageRuntimeDependencyTrees(snapshotNodeModulesDir: string, rootDir: string): void {
  const packagesDir = resolve(rootDir, 'packages');
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const packageJsonPath = resolve(packagesDir, entry.name, 'package.json');
    let packageName = '';
    try {
      const raw = readFileSync(packageJsonPath, 'utf8');
      const parsed = JSON.parse(raw) as { name?: unknown };
      packageName = typeof parsed.name === 'string' ? parsed.name.trim() : '';
    } catch {
      continue;
    }

    if (!packageName.startsWith('@happier-dev/')) continue;

    const scopePackageName = packageName.slice('@happier-dev/'.length).trim();
    if (!scopePackageName) continue;

    const sourceNodeModulesDir = resolve(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', scopePackageName, 'node_modules');
    const snapshotPackageNodeModulesDir = resolve(snapshotNodeModulesDir, '@happier-dev', scopePackageName, 'node_modules');
    if (existsSync(sourceNodeModulesDir)) {
      ensureCopiedDirectory(snapshotPackageNodeModulesDir, sourceNodeModulesDir);
    }
    ensureWorkspacePackageRuntimeDependencyFallbacks(snapshotPackageNodeModulesDir, rootDir, packageJsonPath);
  }
}

function ensureExternalPackageRuntimeDependencyTree(
  packageDir: string,
  rootDir: string,
  visited: Set<string>,
  options: CopyMissingEntryOptions & RuntimeDependencyCollectionOptions = {},
): void {
  const packageJsonPath = resolve(packageDir, 'package.json');
  if (!existsSync(packageJsonPath) || visited.has(packageJsonPath)) return;
  visited.add(packageJsonPath);

  const rootNodeModulesDir = resolve(rootDir, 'node_modules');
  const cliNodeModulesDir = resolve(rootDir, 'apps', 'cli', 'node_modules');

  for (const dep of collectExternalRuntimeDepNamesFromPackageJson(packageJsonPath, options)) {
    const destDepPath = resolve(packageDir, 'node_modules', ...dep.name.split('/'));
    const sourceCandidates = [
      resolve(cliNodeModulesDir, ...dep.name.split('/')),
      resolve(rootNodeModulesDir, ...dep.name.split('/')),
    ];

    if (!existsSync(destDepPath)) {
      ensureCopiedDirectoryFromCandidates(destDepPath, sourceCandidates, options);
    }

    if (isDirectoryEntry(destDepPath)) {
      ensureExternalPackageRuntimeDependencyTree(destDepPath, rootDir, visited, options);
    }
  }
}

function ensureExternalPackageRuntimeDependencyTrees(
  snapshotNodeModulesDir: string,
  rootDir: string,
  options: CopyMissingEntryOptions & RuntimeDependencyCollectionOptions = {},
): void {
  const visited = new Set<string>();

  for (const entry of listNodeModulesEntries(snapshotNodeModulesDir)) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === '@happier-dev') continue;

    const packagePath = resolve(snapshotNodeModulesDir, entry.name);
    if (entry.name.startsWith('@')) {
      for (const scopedEntry of listScopedPackageEntries(packagePath)) {
        if (scopedEntry.name.startsWith('.')) continue;
        ensureExternalPackageRuntimeDependencyTree(resolve(packagePath, scopedEntry.name), rootDir, visited, options);
      }
      continue;
    }

    ensureExternalPackageRuntimeDependencyTree(packagePath, rootDir, visited, options);
  }
}

function ensurePackageRuntimeDependenciesFromPackageJson(params: {
  packageJsonPath: string;
  destNodeModulesDir: string;
  rootDir: string;
  visited: Set<string>;
  mergeExistingDirectoryContents?: boolean;
  traverseExistingDependencyTrees?: boolean;
  includeOptionalDependencies?: boolean;
  includePeerDependencies?: boolean;
  remainingTraversalDepth?: number;
}): void {
  const packageName = readPackageNameFromPackageJson(params.packageJsonPath);
  const mergeExistingDirectoryContents = params.mergeExistingDirectoryContents ?? true;
  const traverseExistingDependencyTrees = params.traverseExistingDependencyTrees ?? true;
  const includeOptionalDependencies = params.includeOptionalDependencies ?? true;
  const includePeerDependencies = params.includePeerDependencies ?? true;
  const remainingTraversalDepth = params.remainingTraversalDepth;
  if (params.visited.has(params.packageJsonPath)) {
    return;
  }
  params.visited.add(params.packageJsonPath);

  for (const dep of collectExternalRuntimeDepNamesFromPackageJson(params.packageJsonPath, {
    includeOptionalDependencies,
    includePeerDependencies,
  })) {
    const destDepPath = resolve(params.destNodeModulesDir, ...dep.name.split('/'));
    const existedBefore = existsSync(destDepPath);
    const packageLocalSourceCandidate = packageName
      ? resolve(params.rootDir, 'apps', 'cli', 'node_modules', ...packageName.split('/'), 'node_modules', ...dep.name.split('/'))
      : null;
    const sourceCandidates = (
      mergeExistingDirectoryContents
        ? [packageLocalSourceCandidate, resolve(params.rootDir, 'apps', 'cli', 'node_modules', ...dep.name.split('/')), resolve(params.rootDir, 'node_modules', ...dep.name.split('/'))]
        : [resolve(params.rootDir, 'apps', 'cli', 'node_modules', ...dep.name.split('/')), resolve(params.rootDir, 'node_modules', ...dep.name.split('/')), packageLocalSourceCandidate]
    ).filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);

    ensureCopiedDirectoryFromCandidates(destDepPath, sourceCandidates, {
      mergeExistingDirectoryContents,
      pruneNestedNodeModules: !mergeExistingDirectoryContents,
    });

    if (isDirectoryEntry(destDepPath)) {
      if (traverseExistingDependencyTrees) {
        ensureExternalPackageRuntimeDependencyTree(destDepPath, params.rootDir, params.visited, { mergeExistingDirectoryContents });
        continue;
      }

      if (typeof remainingTraversalDepth === 'number' && remainingTraversalDepth <= 0) {
        continue;
      }

      const nestedNodeModulesDir = resolve(destDepPath, 'node_modules');
      if (existsSync(nestedNodeModulesDir)) {
        continue;
      }
      ensurePackageRuntimeDependenciesFromPackageJson({
        packageJsonPath: resolve(destDepPath, 'package.json'),
        destNodeModulesDir: nestedNodeModulesDir,
        rootDir: params.rootDir,
        visited: params.visited,
        mergeExistingDirectoryContents,
        traverseExistingDependencyTrees: false,
        includeOptionalDependencies,
        includePeerDependencies,
        remainingTraversalDepth:
          typeof remainingTraversalDepth === 'number' ? remainingTraversalDepth - 1 : remainingTraversalDepth,
      });
    }
  }
}

export function ensureCliPackSnapshotRuntimeDependencies(params: {
  snapshotDir: string;
  rootDir: string;
  mergeExistingDirectories?: boolean;
  hydrationScope?: 'full' | 'bundled-workspaces-only';
}): void {
  const snapshotNodeModulesDir = resolve(params.snapshotDir, 'node_modules');
  mkdirSync(snapshotNodeModulesDir, { recursive: true });
  const mergeExistingDirectoryContents = params.mergeExistingDirectories ?? true;
  const hydrationScope = params.hydrationScope ?? 'full';
  const hydrateRootRuntimeGraph = hydrationScope === 'full';
  const fastModeTraversalDepth = mergeExistingDirectoryContents ? undefined : 1;

  const visited = new Set<string>();
  if (hydrateRootRuntimeGraph) {
    ensurePackageRuntimeDependenciesFromPackageJson({
      packageJsonPath: resolve(params.snapshotDir, 'package.json'),
      destNodeModulesDir: snapshotNodeModulesDir,
      rootDir: params.rootDir,
      visited,
      mergeExistingDirectoryContents,
      traverseExistingDependencyTrees: mergeExistingDirectoryContents,
      includeOptionalDependencies: mergeExistingDirectoryContents,
      includePeerDependencies: true,
      remainingTraversalDepth: fastModeTraversalDepth,
    });
  }

  const bundledScopeDir = resolve(snapshotNodeModulesDir, '@happier-dev');
  for (const entry of listScopedPackageEntries(bundledScopeDir)) {
    const packageDir = resolve(bundledScopeDir, entry.name);
    ensurePackageRuntimeDependenciesFromPackageJson({
      packageJsonPath: resolve(packageDir, 'package.json'),
      destNodeModulesDir: resolve(packageDir, 'node_modules'),
      rootDir: params.rootDir,
      visited,
      mergeExistingDirectoryContents,
      traverseExistingDependencyTrees: mergeExistingDirectoryContents,
      includeOptionalDependencies: mergeExistingDirectoryContents,
      includePeerDependencies: true,
      remainingTraversalDepth: fastModeTraversalDepth,
    });
  }

  if (mergeExistingDirectoryContents && hydrateRootRuntimeGraph) {
    ensureExternalPackageRuntimeDependencyTrees(snapshotNodeModulesDir, params.rootDir, { mergeExistingDirectoryContents });
  }
}

export function ensureCliDistSnapshotNodeModules(params: {
  /** The snapshot's CLI package directory. */
  snapshotDir: string;
  /**
   * The snapshot directory standing for the repository root, given when dist code runs from the snapshot. `snapshotDir`
   * must sit at the CLI package's repository-relative path below it; the CLI's root runtime closure is placed in its
   * `node_modules`, and CLI-local packages keep their source layout instead of receiving private dependency copies.
   */
  rootMirrorDir?: string;
  rootDir: string;
}): void {
  const cliPackageDir = resolve(params.rootDir, 'apps', 'cli');
  const cliNodeModulesDir = resolve(cliPackageDir, 'node_modules');
  const rootNodeModulesDir = resolve(params.rootDir, 'node_modules');
  const snapshotNodeModulesDir = resolve(params.snapshotDir, 'node_modules');
  if (params.rootMirrorDir !== undefined
    && relative(resolve(params.rootMirrorDir, relative(params.rootDir, cliPackageDir)), params.snapshotDir) !== '') {
    throw new Error(`CLI snapshot ${params.snapshotDir} is not the CLI package directory of root mirror ${params.rootMirrorDir}`);
  }

  if (existsSync(cliNodeModulesDir)) {
    mkdirSync(snapshotNodeModulesDir, { recursive: true });
    ensureCopiedDirectory(
      resolve(snapshotNodeModulesDir, '@happier-dev'),
      resolve(cliNodeModulesDir, '@happier-dev'),
    );
    ensureWorkspacePackageManifests(snapshotNodeModulesDir, params.rootDir);
    ensureWorkspacePackageReferencedFiles(snapshotNodeModulesDir, params.rootDir);
    ensureWorkspacePackageDistTrees(snapshotNodeModulesDir, params.rootDir);
    ensureWorkspacePackageRuntimeDependencyTrees(snapshotNodeModulesDir, params.rootDir);
    ensureCopiedNodeModulesEntries(cliNodeModulesDir, snapshotNodeModulesDir, new Set(['@happier-dev']));
    // Without a root mirror, CLI-local packages receive private copies of the dependencies they reach elsewhere.
    if (params.rootMirrorDir === undefined) ensureExternalPackageRuntimeDependencyTrees(snapshotNodeModulesDir, params.rootDir);
  } else if (existsSync(rootNodeModulesDir)) {
    ensureSymlink(snapshotNodeModulesDir, rootNodeModulesDir);
  }

  if (params.rootMirrorDir !== undefined && existsSync(cliNodeModulesDir)) {
    ensureRootRuntimeClosure(params.rootMirrorDir, params.rootDir);
  }
}

/**
 * Replace every symbolic link under `path` (including `path` itself) with a dereferencing copy of its live target.
 * Dangling or cyclic links reject (ENOENT/ELOOP) so a partially live tree is never published.
 */
async function detachLinkedEntries(path: string): Promise<void> {
  if ((await lstat(path)).isSymbolicLink()) {
    const target = await realpath(path);
    await rm(path);
    await cp(target, path, { recursive: true, dereference: true, preserveTimestamps: true, force: true });
    return;
  }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.isDirectory()) await detachLinkedEntries(resolve(path, entry.name));
  }
}

/**
 * Return a detached, retained CLI generation. Only unpublished allocations may be cleaned here;
 * the containing test/session root owns the lifetime of every successfully returned directory.
 */
export async function createRetainedCliSnapshot(params: {
  snapshotDir: string;
  prepare: (privatePayloadDir: string) => Promise<void> | void;
}): Promise<string> {
  const namespace = resolve(params.snapshotDir);
  const parent = dirname(namespace);
  await mkdir(parent, { recursive: true });
  const allocate = async (kind: string) => {
    const path = await mkdtemp(resolve(parent, `${basename(namespace)}-${kind}-`));
    const identity = lstatSync(path);
    return { path, identity };
  };
  type Allocation = Awaited<ReturnType<typeof allocate>>;
  const isOwned = (allocation: Allocation): boolean => {
    const current = lstatSync(allocation.path);
    return current.isDirectory() && !current.isSymbolicLink()
      && current.dev === allocation.identity.dev && current.ino === allocation.identity.ino;
  };
  const requireOwned = (allocation: Allocation) => {
    if (!isOwned(allocation)) throw new Error(`CLI snapshot allocation replaced before return: ${allocation.path}`);
  };
  const holds = (allocation: Allocation): boolean => {
    try {
      return isOwned(allocation);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  const isPresent = (path: string): boolean => {
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  const removeUnpublished = async (allocation: Allocation) => {
    try {
      if (!isOwned(allocation)) {
        console.warn('Retaining replaced unpublished CLI snapshot allocation', allocation.path);
        return;
      }
      await rm(allocation.path, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Could not clean unpublished CLI snapshot allocation', allocation.path, error);
      }
    }
  };
  // The final allocation encloses the published payload. Take back our payload wherever the publication rename put
  // it, then release the allocation only while it is still ours and empty: whatever another actor installed at the
  // allocation path or inside it is retained.
  const removeUnpublishedGeneration = async (generation: Allocation, published: Allocation | undefined) => {
    try {
      if (published && holds(published)) await rm(published.path, { recursive: true, force: true });
      if (!holds(generation)) {
        if (isPresent(generation.path)) console.warn('Retaining replaced unpublished CLI snapshot allocation', generation.path);
        return;
      }
      await rmdir(generation.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') {
        console.warn('Retaining unpublished CLI snapshot allocation that holds foreign entries', generation.path);
      } else if (code !== 'ENOENT') {
        console.warn('Could not clean unpublished CLI snapshot allocation', generation.path, error);
      }
    }
  };
  const staging = await allocate('staging');
  let generation: Allocation | undefined;
  let published: Allocation | undefined;
  let returned = false;
  try {
    // The outer staging identity stays ours when an existing payload installer replaces payload/.
    const payload = resolve(staging.path, 'payload');
    await params.prepare(payload);
    requireOwned(staging);
    // Hydration may deliberately select live workspace links. Detach their contents before
    // exposing a consumer path; a required copy error must never publish a partially live tree.
    // Links are detached in place from their settled live targets and the private payload is then
    // published by rename: re-copying freshly written payload data blocks on block-cloning
    // filesystems (copy_file_range/FICLONE wait for uncommitted source data).
    if ((await lstat(payload)).isDirectory()) await detachLinkedEntries(payload);
    else throw new Error(`CLI snapshot payload is not a directory: ${payload}`);
    requireOwned(staging);
    // The final allocation keeps its own identity and receives the payload at a name that does not exist yet.
    // Renaming onto the allocation itself would be refused on Windows (MoveFileExW rejects an existing directory
    // destination) and, on Linux, would replace whatever directory had taken over the allocation path.
    generation = await allocate('generation');
    requireOwned(generation);
    published = { path: resolve(generation.path, basename(generation.path)), identity: lstatSync(payload) };
    await rename(payload, published.path);
    requireOwned(staging);
    requireOwned(generation);
    requireOwned(published);
    returned = true;
    return published.path;
  } finally {
    if (generation && !returned) await removeUnpublishedGeneration(generation, published);
    await removeUnpublished(staging);
  }
}
