export const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build']

export function isIgnored(relativePath: string): boolean {
  return SKIP_DIRS.some((skip) => relativePath.split(/[/\\]/).includes(skip))
}
