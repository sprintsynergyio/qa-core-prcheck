import path from 'node:path';

/** A POSIX absolute path such as /repo, not a Windows drive path and not a UNC path. */
export function isPosixAbsolute(file: string): boolean {
  const slashed = file.replaceAll('\\', '/');
  return slashed.startsWith('/') && !slashed.startsWith('//');
}

export function toForwardSlashes(file: string): string {
  return file.replaceAll('\\', '/');
}

/**
 * Resolve file against root. On Windows a POSIX root such as /repo stays POSIX, so path.resolve
 * does not prefix the current drive. A real Windows root still uses path.resolve.
 */
export function resolveRepoPath(root: string, file: string): string {
  if (process.platform === 'win32' && isPosixAbsolute(root)) {
    return path.posix.resolve(toForwardSlashes(root), toForwardSlashes(file));
  }
  return path.resolve(root, file);
}

/** The repo-relative POSIX path of file, or null when it is not inside root. */
export function relativeRepoPath(root: string, file: string): string | null {
  const absolute = resolveRepoPath(root, file);
  const base = resolveRepoPath(root, '.');
  const relative = process.platform === 'win32' && isPosixAbsolute(root)
    ? path.posix.relative(base, absolute)
    : path.relative(base, absolute).split(path.sep).join('/');
  if (relative === '' || relative === '..' || relative.startsWith('../') || relative.startsWith('..\\')) return null;
  if (path.isAbsolute(relative) || relative.startsWith('/')) return null;
  return relative;
}
