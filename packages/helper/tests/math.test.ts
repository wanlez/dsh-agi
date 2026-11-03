import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * The ball's math arm: markdown.js parks TeX in `.md-math` placeholders, math.js
 * typesets them with the vendored KaTeX bundle, and neither runs on a body that
 * is still streaming. The bundle is a build artifact (`pnpm build:vendor`), so
 * the functional cases skip on a fresh clone; the source guards never do.
 */
const here = fileURLToPath(new URL('.', import.meta.url))
const assets = join(here, '../assets')
const vendor = join(assets, 'vendor/katex.js')
const built = existsSync(vendor)
const skip = built ? false : 'run `pnpm --filter @dsh-agi/helper build:vendor` first'

function source(file: string): string {
  return readFileSync(join(assets, file), 'utf8')
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/^\s*\/\/.*$/gm, '')
}

describe('ball math rendering', () => {
  it('typesets a formula through the vendored KaTeX bundle', { skip }, async () => {
    const module = await import(pathToFileURL(vendor).href)
    const inline = module.renderTexToHtml('E=mc^2', false)
    assert.match(inline, /class="katex"/)
    assert.equal(inline.includes('katex-display'), false)
    assert.match(module.renderTexToHtml('\\frac{a}{b}', true), /class="katex-display"/)
    // The bundle never throws: TeX that does not parse lands in KaTeX's error span.
    assert.match(module.renderTexToHtml('\\frac{a}{', false), /class="katex-error"/)
  })

  it('ships a woff2-only sheet whose faces are all present', { skip }, () => {
    const css = readFileSync(join(assets, 'vendor/katex/katex.min.css'), 'utf8')
    const sources = [...css.matchAll(/src:([^;}]+)/g)].flatMap((match) => match[1].split(','))
    assert.ok(sources.length > 0)
    assert.equal(sources.some((entry) => !entry.includes('.woff2')), false)
    const faces = new Set((css.match(/url\(fonts\/([^)]+)\)/g) ?? []).map((entry) => entry.slice('url(fonts/'.length, -1)))
    const shipped = new Set(readdirSync(join(assets, 'vendor/katex/fonts')))
    for (const face of faces) assert.ok(shipped.has(face), `${face} is missing from assets/vendor/katex/fonts`)
  })

  it('typesets and highlights settled bodies only', () => {
    const shell = source('shell.js')
    assert.match(shell, /import \{ typesetMath \} from '\.\/math\.js'/)
    assert.match(shell, /renderMarkdown\(text, \{ compact, copyLabel: chatLabels\.copy, live \}\)/)
    assert.match(shell, /if \(!live\) \{\s*void upgradeCodeBlocks\(element\)\s*void typesetMath\(element\)/)
  })

  it('marks a formula as rendered so a second pass skips it', () => {
    const math = source('math.js')
    assert.match(math, /querySelectorAll\('\.md-math:not\(\[data-math-rendered\]\)'\)/)
    assert.match(math, /node\.setAttribute\('data-math-rendered', 'true'\)/)
    // The HTML fragment parser is what puts KaTeX's MathML in the MathML namespace.
    assert.match(math, /template\.innerHTML = html/)
    assert.match(math, /import\('\.\/vendor\/katex\.js'\)/)
  })

  it('loads the vendored KaTeX sheet in the ball page', () => {
    assert.match(source('floating.html'), /<link rel="stylesheet" href="vendor\/katex\/katex\.min\.css">/)
  })

  it('keeps a wide formula inside the panel instead of widening the transcript', () => {
    const css = source('chat.css')
    assert.match(css, /\.md \.katex-display \{\s*max-width: 100%;\s*overflow-x: auto;/)
    // A centered block wider than its box would leave the left half unreachable.
    assert.match(css, /\.md \.katex-display > \.katex \{\s*width: max-content;\s*min-width: 100%;/)
  })
})
