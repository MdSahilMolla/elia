const tracked = Bun.spawnSync(['git', 'ls-files', '-z'], { stdout: 'pipe', stderr: 'pipe' })
if (tracked.exitCode !== 0) throw new Error(new TextDecoder().decode(tracked.stderr))

const suspicious = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:ghp|github_pat|xox[baprs])_[A-Za-z0-9_\-]{20,}\b/,
  /\bsk-[A-Za-z0-9]{24,}\b/,
  /\bBearer\s+[A-Za-z0-9._\-]{24,}\b/,
]
const decoder = new TextDecoder()
const failures: string[] = []
for (const file of decoder.decode(tracked.stdout).split('\0').filter(Boolean)) {
  if (/\.(?:png|jpg|jpeg|gif|ico|woff2?|ttf|zip|gz|pdf)$/i.test(file)) continue
  let text: string
  try {
    text = await Bun.file(file).text()
  } catch {
    continue
  }
  for (const pattern of suspicious) {
    if (pattern.test(text)) failures.push(`${file}: matched ${pattern}`)
  }
}
if (failures.length > 0) {
  console.error('High-confidence secret patterns found in tracked files:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log('Secret scan passed: no high-confidence credential material found in tracked files.')
