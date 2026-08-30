export const SKIP_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  // Windows system directories that sit at a drive root. Searching or listing
  // from `C:\` or `D:\` otherwise descends into these and fails with
  // "Access is denied", which used to abort the whole search.
  'System Volume Information',
  '$RECYCLE.BIN',
  '$Recycle.Bin',
  'Config.Msi',
  'Recovery',
  '$WinREAgent',
  '$SysReset',
  'PerfLogs',
]

/** Files (not directories) at a drive root that break a recursive scan. */
export const SKIP_ROOT_FILES = ['DumpStack.log.tmp', 'pagefile.sys', 'hiberfil.sys', 'swapfile.sys']

export function isIgnored(relativePath: string): boolean {
  const parts = relativePath.split(/[/\\]/)
  return SKIP_DIRS.some((skip) => parts.includes(skip)) || SKIP_ROOT_FILES.includes(parts[parts.length - 1] ?? '')
}
