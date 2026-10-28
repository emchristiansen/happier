const fs = require('node:fs');
const path = require('node:path');

function readDirectories(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function resolvePackageSpawnHelperPaths(packageDir) {
  return [
    path.join(packageDir, 'build', 'Release', 'spawn-helper'),
    path.join(packageDir, 'build', 'Debug', 'spawn-helper'),
    ...readDirectories(path.join(packageDir, 'prebuilds'))
      .map((entry) => path.join(packageDir, 'prebuilds', entry.name, 'spawn-helper')),
  ];
}

function fixNodePtyPackageSpawnHelperPermissions(packageDir) {
  const paths = resolvePackageSpawnHelperPaths(packageDir);
  let fixed = 0;
  for (const helperPath of paths) {
    try {
      fs.chmodSync(helperPath, 0o755);
      fixed += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { fixed, paths };
}

function fixNodePtySpawnHelperPermissions(options = {}) {
  const root = path.resolve(String(options.cwd ?? process.cwd()).trim() || process.cwd());
  const results = [
    path.join(root, 'node_modules', 'node-pty'),
    path.join(root, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch'),
  ].map(fixNodePtyPackageSpawnHelperPermissions);
  return {
    fixed: results.reduce((total, result) => total + result.fixed, 0),
    paths: results.flatMap((result) => result.paths),
  };
}

module.exports = { fixNodePtyPackageSpawnHelperPermissions, fixNodePtySpawnHelperPermissions };
