// Two things made every frame of the live REPL far more expensive than it
// needed to be. A CPU profile of the working line (a spark, a label, a clock)
// had the process burning a whole core:
//
// 1. Ink measures every piece of text it lays out with the `string-width`
//    package. Under Bun, for any line with a non-ASCII character in it — and
//    every status line has one: `·`, `…`, `✦` — that package segments
//    graphemes and runs a `\p{RGI_Emoji}` set-notation regex per cluster. That
//    one regex was 47% of all process time; 2,000 measurements took 878ms
//    against 1ms for `Bun.stringWidth`, which was written as a drop-in for it.
//
// 2. React ran its development build, because nothing sets NODE_ENV — and
//    setting it is not an option: every command elia runs for you would
//    inherit it (`npm install` with NODE_ENV=production skips devDependencies).
//
// ES modules cannot be patched from outside, so both are fixed as the modules
// load, through a Bun runtime plugin that must be installed before Ink or
// React is first imported. Each rewrite checks that the file still has the
// shape it expects and leaves it untouched otherwise. `ELIA_FAST_RENDER=off`
// turns both off.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const WIDTH_MARKER = 'export default function stringWidth('

/**
 * `string-width`'s own source, keeping its measurement for the cases where
 * Bun's differs on something a terminal can show — conjoining Hangul jamo, as
 * in NFD-normalised file names, and `ambiguousIsNarrow: false` — and using
 * `Bun.stringWidth` for everything else.
 */
export function fastenedStringWidthSource(source: string): string {
  if (!source.includes(WIDTH_MARKER)) return source
  return `${source.replace(WIDTH_MARKER, 'function packageStringWidth(')}
const conjoiningJamo = /[\\u1100-\\u11FF\\uA960-\\uA97F\\uD7B0-\\uD7FF]/;
export default function stringWidth(input, options = {}) {
  if (typeof input !== 'string' || input.length === 0) return 0;
  if (options.ambiguousIsNarrow === false || conjoiningJamo.test(input)) return packageStringWidth(input, options);
  return Bun.stringWidth(input, { countAnsiEscapeCodes: options.countAnsiEscapeCodes === true });
}
`
}

/** React's entry files all read: in production require the production build, else the development one. */
const ENTRY = /^'use strict';\s*if \(process\.env\.NODE_ENV === 'production'\) \{\s*module\.exports = require\('(\.\/cjs\/[\w.-]+\.production\.js)'\);\s*\} else \{\s*module\.exports = require\('\.\/cjs\/[\w.-]+\.development\.js'\);\s*\}\s*$/

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/**
 * An ES module re-exporting a CommonJS file by name. Bun works out a CommonJS
 * module's named exports by reading its source, but not for source a plugin
 * supplies — so a plugin-made entry spells its exports out, and Ink's
 * `import { NoEventPriority } from 'react-reconciler/constants.js'` still
 * resolves.
 */
function esmReexport(target: string, load: (path: string) => Record<string, unknown>): string {
  const names = Object.keys(load(target)).filter((name) => name !== 'default' && IDENTIFIER.test(name))
  return [
    `const entry = require(${JSON.stringify(target)});`,
    'export default entry;',
    ...names.map((name) => `export const ${name} = entry.${name};`),
    '',
  ].join('\n')
}

/**
 * An entry file of react / react-reconciler / scheduler, pointed straight at
 * its production build. The JSX dev runtime is the exception: Bun's
 * transpiler calls `jsxDEV` whenever NODE_ENV was not "production" at startup,
 * and React's production dev runtime leaves `jsxDEV` undefined — so it gets a
 * `jsxDEV` built on the production `jsx`.
 */
export function productionEntrySource(path: string, source: string, load: (path: string) => Record<string, unknown> = require): string {
  const match = ENTRY.exec(source)
  if (!match) return source
  const directory = dirname(path)
  if (/[\\/]jsx-dev-runtime\.js$/.test(path)) {
    const runtime = join(directory, 'cjs', 'react-jsx-runtime.production.js')
    if (!existsSync(runtime)) return source
    return [
      `const runtime = require(${JSON.stringify(runtime)});`,
      'export const Fragment = runtime.Fragment;',
      'export function jsxDEV(type, config, maybeKey, isStaticChildren) {',
      '  return (isStaticChildren ? runtime.jsxs : runtime.jsx)(type, config, maybeKey);',
      '}',
      'export default { Fragment, jsxDEV };',
      '',
    ].join('\n')
  }
  const target = join(directory, match[1]!)
  if (!existsSync(target)) return source
  return esmReexport(target, load)
}

export function fastRenderEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(off|0|false|no)$/i.test((env.ELIA_FAST_RENDER ?? '').trim())
}

/** Has React already been loaded? Swapping its build now would leave two copies — and broken hooks. */
function reactAlreadyLoaded(): boolean {
  return Object.keys(require.cache).some((key) => /[\\/]node_modules[\\/](?:react|react-reconciler)[\\/]/.test(key))
}

let installed: { stringWidth: boolean; reactProduction: boolean } | undefined

/**
 * Install the rewrites for every import from here on. Call it before the Ink
 * app is imported; safe to call more than once.
 */
export function installFastRendering(): { stringWidth: boolean; reactProduction: boolean } {
  if (installed) return installed
  if (typeof Bun === 'undefined' || typeof Bun.plugin !== 'function' || !fastRenderEnabled()) {
    installed = { stringWidth: false, reactProduction: false }
    return installed
  }
  // Under `bun test` React stays as the suite loaded it: development, with its warnings.
  const reactProduction = process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'development' && !reactAlreadyLoaded()
  installed = { stringWidth: true, reactProduction }
  Bun.plugin({
    name: 'elia-fast-render',
    setup(build) {
      build.onLoad({ filter: /[\\/]node_modules[\\/]string-width[\\/]index\.js$/ }, (args) => ({
        contents: fastenedStringWidthSource(readFileSync(args.path, 'utf8')),
        loader: 'js',
      }))
      if (reactProduction) {
        build.onLoad({ filter: /[\\/]node_modules[\\/](?:react|react-reconciler|scheduler)[\\/](?:index|jsx-runtime|jsx-dev-runtime|constants)\.js$/ }, (args) => ({
          contents: productionEntrySource(args.path, readFileSync(args.path, 'utf8')),
          loader: 'js',
        }))
      }
    },
  })
  return installed
}
