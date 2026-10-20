import { validateOrdinaryReaderPath } from '@/rpc/handlers/pathSecurity';
import { realpathSync } from 'node:fs'
import { posix, win32 } from 'node:path'

import type { MachineFileBrowserRoot } from '@happier-dev/protocol'

type MachineBrowsePathValidationResult =
  | Readonly<{ valid: true; resolvedPath: string }>
  | Readonly<{ valid: false; error: string }>

type ValidateMachineBrowsePathInput = Readonly<{
  targetPath: string
  roots: readonly MachineFileBrowserRoot[]
  platform?: NodeJS.Platform
}>

function isWithinRoot(rootPath: string, targetPath: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    const normalizedRoot = resolvePathForComparison(rootPath, platform)
    const normalizedTarget = resolvePathForComparison(targetPath, platform)
    const relativePath = win32.relative(normalizedRoot.toLowerCase(), normalizedTarget.toLowerCase())
    return relativePath === '' || (!relativePath.startsWith('..\\') && relativePath !== '..' && !win32.isAbsolute(relativePath))
  }

  const normalizedRoot = resolvePathForComparison(rootPath, platform)
  const normalizedTarget = resolvePathForComparison(targetPath, platform)
  const relativePath = posix.relative(normalizedRoot, normalizedTarget)
  return relativePath === '' || (!relativePath.startsWith('../') && relativePath !== '..' && !posix.isAbsolute(relativePath))
}

function resolvePathForComparison(path: string, platform: NodeJS.Platform): string {
  const resolved = platform === 'win32' ? win32.resolve(path) : posix.resolve(path)
  if (platform !== process.platform) {
    return resolved
  }
  try {
    return realpathSync.native?.(resolved) ?? realpathSync(resolved)
  } catch {
    return resolved
  }
}

export function validateMachineBrowsePath(input: ValidateMachineBrowsePathInput): MachineBrowsePathValidationResult {
  const platform = input.platform ?? process.platform
  const rawPath = String(input.targetPath ?? '').trim()
  if (!rawPath) {
    return { valid: false, error: 'Path is required' }
  }
  if (platform === 'win32' ? !win32.isAbsolute(rawPath) : !posix.isAbsolute(rawPath)) {
    return { valid: false, error: 'Path must be absolute' }
  }

  if (platform === process.platform) {
    const restriction = validateOrdinaryReaderPath(rawPath)
    if (!restriction.valid) return { valid: false, error: restriction.error ?? 'Access denied: private native domain' }
  }
  const resolvedPath = resolvePathForComparison(rawPath, platform)
  const allowed = input.roots.some((root) => isWithinRoot(root.path, resolvedPath, platform))
  if (!allowed) {
    return { valid: false, error: 'Path is outside the allowed machine browse roots' }
  }

  return { valid: true, resolvedPath }
}
