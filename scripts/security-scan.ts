const tracked = Bun.spawnSync(['git', 'ls-files', '-z'], { stdout: 'pipe', stderr: 'pipe' })
if (tracked.exitCode !== 0) throw new Error(new TextDecoder().decode(tracked.stderr))

const suspicious = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:ghp|github_pat|xox[baprs])_[A-Za-z0-9_\-]{20,}\b/,
  /\bsk-[A-Za-z0-9]{24,}\b/,
  /\bBearer\s+[A-Za-z0-9._\-]{24,}\b/,
]
// A line carrying this marker is a deliberate fake — a redaction test fixture,
// a docs example — and is exempt. Same convention as detect-secrets.
const ALLOWLIST_MARKER = 'pragma: allowlist secret'
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
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.includes(ALLOWLIST_MARKER)) return
    for (const pattern of suspicious) {
      if (pattern.test(line)) failures.push(`${file}:${index + 1}: matched ${pattern}`)
    }
  })
}
if (failures.length > 0) {
  console.error('High-confidence secret patterns found in tracked files:')
  for (const failure of failures) console.error(`- ${failure}`)
  console.error(`\nIf a match is a deliberate fake (test fixture, docs example), append a "${ALLOWLIST_MARKER}" comment to that line.`)
  process.exit(1)
}
console.log('Secret scan passed: no high-confidence credential material found in tracked files.')
