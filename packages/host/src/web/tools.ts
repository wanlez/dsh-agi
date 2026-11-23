/**
 * The browser channel and its tools.
 *
 * Deterministic first: the page is read as a list of controls with stable refs, and every
 * action is resolved by rule (normalized name, role, region) inside the program. The model only
 * names the target. One match acts; zero or several matches stop and report — never guess.
 *
 * Coverage: the main document, every iframe (including cross-origin ones Playwright exposes),
 * and open shadow roots, because intranet back offices are built out of all three.
 * @module web/tools
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserContext, Frame, Page } from 'playwright-core'
import type { WebSettings } from './settings.ts'
import { findFlow, listFlows, runFlow, saveFlow, type FlowStep } from './flow.ts'

interface TextBlock { readonly type: 'text'; readonly text: string }
function block(text: string): TextBlock { return { type: 'text', text } }

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false }
}

/** One control the page exposes. */
export interface WebControl {
  ref: string
  role: string
  name: string
  frame: string
  visible: boolean
  enabled: boolean
  rect: number[]
}

/** Role aliases: a tag name and the ARIA role people type for it must meet in the middle. */
export function canonicalRole(role: string): string {
  const value = role.trim().toLowerCase()
  if (value === 'select' || value === 'listbox' || value === 'dropdown') return 'combobox'
  if (value === 'input' || value === 'textarea' || value === 'text field') return 'textbox'
  if (value === 'a') return 'link'
  if (value === 'btn') return 'button'
  return value
}

/** Compare form of a label: trimmed, lowercased, full-width folded, whitespace collapsed. */
export function normalizeLabel(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** The walker injected into one frame: main tree plus open shadow roots, controls only. */
const WALK = `(() => {
  const MAX = 3000
  const out = []
  const interactiveTags = new Set(['a','button','input','select','textarea','option','summary'])
  const interactiveRoles = new Set(['button','link','tab','menuitem','menuitemcheckbox','checkbox','radio','switch','textbox','searchbox','combobox','option','slider'])
  let counter = 0
  const visit = (root, depth) => {
    if (!root || depth > 40 || out.length >= MAX) return
    let nodes
    try { nodes = root.querySelectorAll('*') } catch (error) { return }
    for (const el of nodes) {
      if (out.length >= MAX) return
      if (el.shadowRoot) {
        try { visit(el.shadowRoot, depth + 1) } catch (error) { /* closed or broken shadow root */ }
      }
      const tag = (el.tagName || '').toLowerCase()
      const role = (el.getAttribute && el.getAttribute('role')) || ''
      const editable = el.isContentEditable === true
      if (!interactiveTags.has(tag) && !interactiveRoles.has(role) && !editable) continue
      let rect
      try { rect = el.getBoundingClientRect() } catch (error) { continue }
      if (!rect) continue
      const style = window.getComputedStyle(el)
      const visible = rect.width > 1 && rect.height > 1
        && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
      let name = ''
      try {
        const aria = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || ''
        let labelled = ''
        try {
          if (el.labels && el.labels.length > 0) labelled = el.labels[0].innerText || ''
          else if (el.id) {
            const escaped = window.CSS && window.CSS.escape ? window.CSS.escape(el.id) : el.id
            const label = document.querySelector('label[for="' + escaped + '"]')
            if (label) labelled = label.innerText || ''
          }
        } catch (error) { labelled = '' }
        // A select's innerText is its options, never its name; form fields read like fields.
        const isField = tag === 'select' || tag === 'input' || tag === 'textarea'
        name = (isField
          ? (aria || labelled || (typeof el.value === 'string' ? el.value : '') || el.innerText || '')
          : (el.innerText || aria || labelled || ''))
          .replace(/\\s+/g, ' ').trim()
      } catch (error) { name = '' }
      counter += 1
      const ref = 'FRAME' + 'e' + counter
      try { el.setAttribute('data-agi-ref', ref) } catch (error) { continue }
      out.push({
        ref,
        role: role || (tag === 'a' ? 'link' : tag === 'input' ? 'textbox' : tag),
        name: name.length > 80 ? name.slice(0, 80) : name,
        visible,
        enabled: el.disabled !== true && el.getAttribute('aria-disabled') !== 'true',
        rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
      })
    }
  }
  visit(document, 0)
  return out
})()`

/** Text of one frame's visible body, capped. */
const TEXT = `(() => { try { return (document.body ? document.body.innerText : '').slice(0, 20000) } catch (error) { return '' } })()`

/**
 * Holds the single browser context and resolves actions against it.
 */
export class BrowserChannel {
  private context: BrowserContext | undefined
  private page: Page | undefined
  private knownPages = new Set<Page>()
  /** Pages opened since the channel started, recorded by the context listener. */
  private opened: Page[] = []

  constructor(
    private readonly settings: () => WebSettings,
    private readonly dataDir: string,
  ) {}

  private profileDirectory(): string {
    const settings = this.settings()
    return settings.profileDir !== '' ? settings.profileDir : join(this.dataDir, `web-profile-${settings.mode}`)
  }

  private executable(): string {
    const settings = this.settings()
    if (settings.mode === 'chrome') {
      if (settings.chromePath === '' || !existsSync(settings.chromePath)) {
        throw new Error('没有指定 Chrome 路径。请在设置里手动选择 chrome.exe（不会自动查找）。')
      }
      return settings.chromePath
    }
    if (settings.chromiumPath === '' || !existsSync(settings.chromiumPath)) {
      throw new Error('内置 Chromium 还没准备好。请先在设置里下载，或改用系统 Chrome 模式。')
    }
    return settings.chromiumPath
  }

  /** Launch, or reattach, then draw the first page and remember the set we know. */
  private async start(): Promise<Page> {
    const settings = this.settings()
    const { chromium } = await import('playwright-core')
    if (settings.mode === 'attach') {
      if (settings.cdpUrl === '') throw new Error('attach 模式需要填写 CDP 地址（例如 http://127.0.0.1:9222）。')
      const browser = await chromium.connectOverCDP(settings.cdpUrl)
      this.context = browser.contexts()[0]
      if (this.context === undefined) throw new Error('已连接，但这个浏览器没有可用的上下文。')
    } else {
      const profile = this.profileDirectory()
      mkdirSync(profile, { recursive: true })
      this.context = await chromium.launchPersistentContext(profile, {
        executablePath: this.executable(),
        headless: false,
        viewport: null,
        args: ['--start-maximized', '--no-first-run', '--no-default-browser-check'],
      })
    }
    this.knownPages = new Set()
    this.opened = []
    for (const page of this.context.pages()) this.knownPages.add(page)
    // Only pages created from now on count as "opened by an action".
    this.context.on('page', (page: Page) => {
      this.knownPages.add(page)
      this.opened.push(page)
    })
    this.page = this.context.pages()[0] ?? (await this.context.newPage())
    return this.page
  }

  /** The page every tool works on; relaunches once when the browser died underneath us. */
  async ensure(): Promise<Page> {
    if (this.context !== undefined && this.page !== undefined && !this.page.isClosed()) return this.page
    this.context = undefined
    this.page = undefined
    return await this.start()
  }

  /** A closed target looks like a crash; one relaunch is allowed, a repeated one is not. */
  private async withPage<T>(run: (page: Page) => Promise<T>): Promise<T> {
    try {
      return await run(await this.ensure())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/Target closed|Target page, context or browser has been closed|Browser closed|crash/i.test(message)) throw error
      this.context = undefined
      this.page = undefined
      return await run(await this.start())
    }
  }

  /**
   * Follow a popup: a page that appeared because of the action becomes the current one.
   * The context listener records new pages, so this only waits briefly for one to arrive.
   */
  private async followPopup(timeoutMs = 400): Promise<string> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const candidate = this.opened.filter((page) => !page.isClosed()).pop()
      if (candidate !== undefined) {
        this.page = candidate
        await candidate.waitForLoadState('domcontentloaded').catch(() => undefined)
        return candidate.url()
      }
      if (Date.now() >= deadline) return ''
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  /** Which frame a ref belongs to. */
  private frameOf(page: Page, ref: string): Frame {
    const match = /^f(\d+)e\d+$/.exec(ref)
    if (match === null) throw new Error(`ref 格式不对：${ref}（应形如 f0e12，来自最近一次读取）`)
    const frames = page.frames()
    const frame = frames[Number(match[1])]
    if (frame === undefined) throw new Error(`找不到第 ${String(match[1])} 个页面框架，请重新读取页面。`)
    return frame
  }

  /** Read every frame, main document and open shadow roots included. */
  async controls(limit = 300): Promise<{ url: string, title: string, frames: number, controls: WebControl[] }> {
    return await this.withPage(async (page) => {
      const frames = page.frames()
      const controls: WebControl[] = []
      for (const [index, frame] of frames.entries()) {
        let rows: { ref: string, role: string, name: string, visible: boolean, enabled: boolean, rect: number[] }[]
        try {
          rows = await frame.evaluate(WALK.replaceAll('FRAME', `f${String(index)}`)) as typeof rows
        } catch {
          // A detached or crashed frame contributes nothing; the rest still read.
          continue
        }
        for (const row of rows) {
          if (controls.length >= limit) break
          controls.push({ ...row, frame: frame.url() })
        }
      }
      return { url: page.url(), title: await page.title().catch(() => ''), frames: frames.length, controls }
    })
  }

  /**
   * Rule-based search: normalized name containment, optional role filter, visible first.
   * @returns the candidates, best first, plus how the query was normalized.
   */
  async find(query: string, options: { role?: string, includeHidden?: boolean, limit?: number } = {}): Promise<{
    url: string, query: string, total: number, candidates: WebControl[]
  }> {
    const read = await this.controls(3000)
    const wanted = normalizeLabel(query)
    const role = options.role === undefined ? '' : normalizeLabel(options.role)
    const hits = read.controls.filter((control) => {
      if (!options.includeHidden && !control.visible) return false
      if (role !== '' && canonicalRole(normalizeLabel(control.role)) !== canonicalRole(role)) return false
      return normalizeLabel(control.name).includes(wanted)
    })
    const exact = hits.filter((control) => normalizeLabel(control.name) === wanted)
    const ordered = [...exact, ...hits.filter((control) => !exact.includes(control))]
    const limit = Math.max(1, Math.min(options.limit ?? 10, 50))
    return { url: read.url, query, total: hits.length, candidates: ordered.slice(0, limit) }
  }

  /** Resolve one target; ambiguity is a refusal, not a guess. */
  private async resolve(query: string, role?: string): Promise<WebControl> {
    const found = await this.find(query, { ...role === undefined ? {} : { role }, limit: 10 })
    if (found.total === 0) throw new Error(`页面上找不到「${query}」${role === undefined ? '' : `（角色 ${role}）`}，没有执行任何点击。`)
    if (found.total > 1) {
      const names = found.candidates.map((item) => `${item.ref}:${item.name}`).join('、')
      throw new Error(`「${query}」命中 ${String(found.total)} 个，未执行：${names}。请用更完整的名字或加角色限定。`)
    }
    return found.candidates[0]!
  }

  async clickTarget(target: { ref?: string, text?: string, role?: string }): Promise<Record<string, unknown>> {
    const control = target.ref !== undefined
      ? (await this.controls(3000)).controls.find((item) => item.ref === target.ref)
      : await this.resolve(target.text ?? '', target.role)
    if (control === undefined) throw new Error(`找不到 ${String(target.ref)}，请重新读取页面拿新编号。`)
    return await this.withPage(async (page) => {
      const frame = this.frameOf(page, control.ref)
      const locator = frame.locator(`[data-agi-ref="${control.ref}"]`)
      if ((await locator.count()) === 0) throw new Error(`${control.ref} 已失效，请重新读取页面。`)
      await locator.first().scrollIntoViewIfNeeded()
      await locator.first().click({ timeout: 15_000 })
      const popup = await this.followPopup()
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined)
      return { ok: true, clicked: control.name, url: page.url(), title: await page.title().catch(() => ''), ...popup === '' ? {} : { switchedTo: popup } }
    })
  }

  async typeTarget(target: { ref?: string, text?: string, role?: string, value: string, submit?: boolean }): Promise<Record<string, unknown>> {
    const control = target.ref !== undefined
      ? (await this.controls(3000)).controls.find((item) => item.ref === target.ref)
      : await this.resolve(target.text ?? '', target.role ?? 'textbox')
    if (control === undefined) throw new Error(`找不到 ${String(target.ref)}，请重新读取页面拿新编号。`)
    return await this.withPage(async (page) => {
      const frame = this.frameOf(page, control.ref)
      const locator = frame.locator(`[data-agi-ref="${control.ref}"]`).first()
      await locator.scrollIntoViewIfNeeded()
      await locator.click({ timeout: 15_000 }).catch(() => undefined)
      await locator.fill('', { timeout: 15_000 }).catch(() => undefined)
      await locator.type(target.value, { timeout: 15_000 })
      if (target.submit === true) await locator.press('Enter')
      const popup = await this.followPopup()
      if (target.submit === true) await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined)
      return { ok: true, filled: control.name, url: page.url(), ...popup === '' ? {} : { switchedTo: popup } }
    })
  }

  async hoverTarget(target: { text?: string, role?: string }): Promise<Record<string, unknown>> {
    const control = await this.resolve(target.text ?? '', target.role)
    return await this.withPage(async (page) => {
      const frame = this.frameOf(page, control.ref)
      const locator = frame.locator(`[data-agi-ref="${control.ref}"]`).first()
      await locator.scrollIntoViewIfNeeded()
      await locator.hover({ timeout: 15_000 })
      await new Promise((resolve) => setTimeout(resolve, 150))
      return { ok: true, hovered: control.name, url: page.url() }
    })
  }

  /** Choose an option of a `<select>` by its visible label (value as fallback). */
  async selectTarget(target: { text?: string, role?: string, value: string }): Promise<Record<string, unknown>> {
    const control = await this.resolve(target.text ?? '', target.role ?? 'combobox')
    return await this.withPage(async (page) => {
      const frame = this.frameOf(page, control.ref)
      const locator = frame.locator(`[data-agi-ref="${control.ref}"]`).first()
      await locator.scrollIntoViewIfNeeded()
      try {
        await locator.selectOption({ label: target.value }, { timeout: 15_000 })
      } catch {
        await locator.selectOption(target.value, { timeout: 15_000 })
      }
      return { ok: true, selected: target.value, control: control.name, url: page.url() }
    })
  }

  /** Visible text of the page and its frames, optionally only the parts around a phrase. */
  async text(query?: string): Promise<Record<string, unknown>> {
    return await this.withPage(async (page) => {
      const parts: string[] = []
      for (const frame of page.frames()) {
        try { parts.push(await frame.evaluate(TEXT) as string) } catch { /* detached frame */ }
      }
      const all = parts.join('\n').replace(/\n{3,}/g, '\n\n')
      if (query === undefined || query === '') return { ok: true, url: page.url(), chars: all.length, text: all.slice(0, 4_000) }
      const wanted = normalizeLabel(query)
      const hits: string[] = []
      for (const line of all.split('\n')) {
        if (normalizeLabel(line).includes(wanted)) hits.push(line.trim().slice(0, 200))
        if (hits.length >= 20) break
      }
      return { ok: true, url: page.url(), found: hits.length > 0, count: hits.length, hits }
    })
  }

  /** Wait for a URL fragment, a phrase, or a selector; this is the flow's step anchor. */
  async wait(options: { urlContains?: string, text?: string, selector?: string, timeoutMs?: number }): Promise<Record<string, unknown>> {
    const timeout = Math.max(500, Math.min(options.timeoutMs ?? 10_000, 60_000))
    const started = Date.now()
    const normalizedText = options.text === undefined ? undefined : normalizeLabel(options.text)
    while (Date.now() - started < timeout) {
      const read = await this.controls(3000).catch(() => undefined)
      if (read !== undefined) {
        if (options.urlContains !== undefined && read.url.includes(options.urlContains)) {
          return { ok: true, matched: 'url', url: read.url, elapsedMs: Date.now() - started }
        }
        if (normalizedText !== undefined) {
          // Text expectations are about what the page says, not about control names.
          const pageText = await this.withPage(async (current) => {
            const parts: string[] = []
            for (const frame of current.frames()) {
              try { parts.push(await frame.evaluate(TEXT) as string) } catch { /* detached frame */ }
            }
            return normalizeLabel(parts.join('\n'))
          }).catch(() => '')
          if (pageText.includes(normalizedText)) {
            return { ok: true, matched: 'text', url: read.url, elapsedMs: Date.now() - started }
          }
        }
        if (options.selector !== undefined) {
          const hit = await this.withPage(async (page) => await page.$(options.selector!)).catch(() => null)
          if (hit !== null) return { ok: true, matched: 'selector', url: read.url, elapsedMs: Date.now() - started }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return { ok: false, matched: '', elapsedMs: Date.now() - started, url: (await this.ensure()).url() }
  }

  async navigate(url: string): Promise<Record<string, unknown>> {
    return await this.withPage(async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await this.followPopup()
      return { ok: true, url: page.url(), title: await page.title().catch(() => '') }
    })
  }

  async back(): Promise<Record<string, unknown>> {
    return await this.withPage(async (page) => {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 })
      return { ok: true, url: page.url(), title: await page.title().catch(() => '') }
    })
  }

  async press(key: string): Promise<Record<string, unknown>> {
    return await this.withPage(async (page) => {
      await page.keyboard.press(key)
      const popup = await this.followPopup()
      return { ok: true, url: page.url(), ...popup === '' ? {} : { switchedTo: popup } }
    })
  }

  async screenshot(): Promise<Record<string, unknown>> {
    return await this.withPage(async (page) => {
      const dir = join(this.dataDir, 'web-shots')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `web-${Date.now()}.png`)
      writeFileSync(file, await page.screenshot({ type: 'png' }))
      return { ok: true, path: file, url: page.url(), title: await page.title().catch(() => '') }
    })
  }

  async close(): Promise<Record<string, unknown>> {
    const context = this.context
    this.context = undefined
    this.page = undefined
    this.knownPages = new Set()
    this.opened = []
    if (context === undefined) return { ok: true, closed: false }
    if (this.settings().mode === 'attach') return { ok: true, closed: false, detached: true }
    await context.close().catch(() => undefined)
    return { ok: true, closed: true }
  }
}

function webTool(options: {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly execute: (args: Record<string, unknown>) => Promise<unknown>
}): unknown {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [block(JSON.stringify(value, null, 2))],
    },
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>) {
      try {
        return JSON.parse(JSON.stringify(await options.execute(args)))
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

function asString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

/** Register the browser tools; the returned function unregisters them. */
export function registerWebTools(
  registry: { register(tool: unknown): () => void },
  channel: BrowserChannel,
  flowDir: string,
): () => void {
  const disposers = [
    registry.register(webTool({
      name: 'web_open',
      description: '打开一个网址（网页 DOM 通道）。打开后用 web_find/web_snapshot 找目标，按名字操作，不要逐像素点截图。',
      parameters: schema({ url: { type: 'string', description: '完整网址，例如 https://example.com' } }, ['url']),
      async execute(args) {
        const url = asString(args, 'url') ?? ''
        if (!/^https?:\/\//i.test(url)) throw new Error('url 必须以 http:// 或 https:// 开头')
        return channel.navigate(url)
      },
    })),
    registry.register(webTool({
      name: 'web_find',
      description:
        '在页面里按名字搜索控件（含 iframe 与 shadow DOM）：规范化后按包含匹配，精确命中优先。'
        + '只返回命中的候选（默认 10 个），不返回整页清单——这是网页任务的主力查找方式。'
        + '命中 1 个就把 ref 交给 web_click；命中多个时用更完整的名字或 role 收窄。',
      parameters: schema({
        text: { type: 'string', description: '目标名字/文字，例如「保存」「用户名」' },
        role: { type: 'string', description: '可选：button / link / textbox / tab 等，收窄用' },
        includeHidden: { type: 'boolean', description: '是否包含不可见控件，默认否' },
        limit: { type: 'number', description: '最多返回几个候选，默认 10' },
      }, ['text']),
      async execute(args) {
        return channel.find(asString(args, 'text') ?? '', {
          ...asString(args, 'role') === undefined ? {} : { role: asString(args, 'role') },
          includeHidden: args.includeHidden === true,
          ...args.limit === undefined ? {} : { limit: Number(args.limit) },
        })
      },
    })),
    registry.register(webTool({
      name: 'web_snapshot',
      description:
        '读取页面的控件清单（主文档 + iframe + shadow DOM），带编号，用于探索未知页面。'
        + '日常找目标请用 web_find；这里会一次返回很多项，只在需要看整页结构时用。',
      parameters: schema({ limit: { type: 'number', description: '最多返回多少项，默认 300' } }),
      async execute(args) { return channel.controls(Math.max(10, Math.min(Number(args.limit ?? 300), 3000))) },
    })),
    registry.register(webTool({
      name: 'web_click',
      description:
        '点击控件。两种给法：text（按名字自动定位，唯一的那个才点，命中 0 或 ≥2 个就报错不执行）'
        + '或 ref（web_find/web_snapshot 返回的编号）。优先用 text，避免多跑一次查找。',
      parameters: schema({
        text: { type: 'string', description: '控件名字，例如「保存」' },
        role: { type: 'string', description: '可选：限定控件角色' },
        ref: { type: 'string', description: '可选：来自 web_find 的编号，例如 f0e12' },
      }),
      async execute(args) {
        return channel.clickTarget({
          ...asString(args, 'text') === undefined ? {} : { text: asString(args, 'text') },
          ...asString(args, 'role') === undefined ? {} : { role: asString(args, 'role') },
          ...asString(args, 'ref') === undefined ? {} : { ref: asString(args, 'ref') },
        })
      },
    })),
    registry.register(webTool({
      name: 'web_type',
      description:
        '往输入框写文字。text 按名字定位（默认角色 textbox），或给 ref；submit=true 时写完按回车。',
      parameters: schema({
        text: { type: 'string', description: '输入框的名字/占位文字' },
        role: { type: 'string', description: '可选：角色，默认 textbox' },
        ref: { type: 'string', description: '可选：输入框编号' },
        value: { type: 'string', description: '要写入的内容' },
        submit: { type: 'boolean', description: '写完是否按回车，默认否' },
      }, ['value']),
      async execute(args) {
        return channel.typeTarget({
          ...asString(args, 'text') === undefined ? {} : { text: asString(args, 'text') },
          ...asString(args, 'role') === undefined ? {} : { role: asString(args, 'role') },
          ...asString(args, 'ref') === undefined ? {} : { ref: asString(args, 'ref') },
          value: asString(args, 'value') ?? '',
          submit: args.submit === true,
        })
      },
    })),
    registry.register(webTool({
      name: 'web_text',
      description: '读取页面可见文字（含 iframe）。给 query 时只返回包含该词的若干行，适合校验「提交成功」这类结果。',
      parameters: schema({ query: { type: 'string', description: '可选：要查找的文字' } }),
      async execute(args) { return channel.text(asString(args, 'query')) },
    })),
    registry.register(webTool({
      name: 'web_wait',
      description:
        '等待一步真正完成：URL 包含某段、页面出现某段文字、或出现某个选择器。流程里每一步之后都应该有一次校验。',
      parameters: schema({
        urlContains: { type: 'string', description: '等待 URL 包含这段文字' },
        text: { type: 'string', description: '等待页面出现这段文字' },
        selector: { type: 'string', description: '等待出现这个 CSS 选择器' },
        timeoutMs: { type: 'number', description: '超时毫秒，默认 10000，最大 60000' },
      }),
      async execute(args) {
        return channel.wait({
          ...asString(args, 'urlContains') === undefined ? {} : { urlContains: asString(args, 'urlContains') },
          ...asString(args, 'text') === undefined ? {} : { text: asString(args, 'text') },
          ...asString(args, 'selector') === undefined ? {} : { selector: asString(args, 'selector') },
          ...args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) },
        })
      },
    })),
    registry.register(webTool({
      name: 'web_hover',
      description: '把鼠标悬停到控件上（名字定位）。展开式菜单、tooltip、二级导航需要先悬停。',
      parameters: schema({
        text: { type: 'string', description: '控件名字' },
        role: { type: 'string', description: '可选：限定角色' },
      }, ['text']),
      async execute(args) {
        return channel.hoverTarget({
          ...asString(args, 'text') === undefined ? {} : { text: asString(args, 'text') },
          ...asString(args, 'role') === undefined ? {} : { role: asString(args, 'role') },
        })
      },
    })),
    registry.register(webTool({
      name: 'web_select',
      description: '选择下拉框（<select>）里的某一项：text 定位下拉框，value 给选项文字（或值）。',
      parameters: schema({
        text: { type: 'string', description: '下拉框的名字/标签' },
        role: { type: 'string', description: '可选：角色，默认 combobox' },
        value: { type: 'string', description: '要选中的选项文字或值' },
      }, ['text', 'value']),
      async execute(args) {
        return channel.selectTarget({
          text: asString(args, 'text') ?? '',
          ...asString(args, 'role') === undefined ? {} : { role: asString(args, 'role') },
          value: asString(args, 'value') ?? '',
        })
      },
    })),
    registry.register(webTool({
      name: 'web_flow_save',
      description:
        '保存一条可反复执行的网页流程（纯代码执行，不需要模型逐步操作）。每步要有 action（click/type/select/hover/press/wait/open/back）、'
        + 'target 和 expect 校验；没有 expect 的步骤执行器会拒绝。保存前先把步骤列给用户确认。',
      parameters: schema({
        name: { type: 'string', description: '流程名，例如「每日对账」' },
        id: { type: 'string', description: '可选：更新已有流程的 id' },
        path_id: { type: 'string', description: '可选：关联的经验库路径 id' },
        steps: { type: 'array', description: '步骤数组：{action, target, value?, role?, expect?}' },
      }, ['name', 'steps']),
      async execute(args) {
        const steps = Array.isArray(args.steps) ? args.steps as FlowStep[] : []
        if (steps.length === 0) throw new Error('steps 不能为空')
        const saved = saveFlow(flowDir, {
          ...asString(args, 'id') === undefined ? {} : { id: asString(args, 'id') },
          name: asString(args, 'name') ?? '',
          ...asString(args, 'path_id') === undefined ? {} : { path_id: asString(args, 'path_id') },
          steps,
        })
        return { ok: true, flow: saved }
      },
    })),
    registry.register(webTool({
      name: 'web_flow_list',
      description: '列出已保存的网页流程（名字、id、步骤数、关联路径）。',
      parameters: schema({}),
      async execute() {
        return { flows: listFlows(flowDir).map((flow) => ({ id: flow.id, name: flow.name, steps: flow.steps.length, path_id: flow.path_id ?? '', updatedAt: flow.updatedAt })) }
      },
    })),
    registry.register(webTool({
      name: 'web_run_flow',
      description:
        '纯代码执行一条已保存的流程：逐步按名字定位、唯一命中才动作、每步用 expect 校验，失败立刻停并返回现场。'
        + 'dryRun=true 只报告“每步会点哪个控件/是否唯一命中”，不执行任何动作——先 dryRun 给人确认，再用 dryRun=false 真跑。',
      parameters: schema({
        name: { type: 'string', description: '流程名或 id' },
        dryRun: { type: 'boolean', description: '默认 true：只报告不执行' },
      }, ['name']),
      async execute(args) {
        const flow = findFlow(flowDir, asString(args, 'name') ?? '')
        if (flow === undefined) throw new Error('找不到这条流程，请先 web_flow_list 看名字')
        return runFlow(channel, flow, { dryRun: args.dryRun !== false })
      },
    })),
    registry.register(webTool({
      name: 'web_press',
      description: '按一个浏览器按键，例如 Enter、Escape、PageDown、Control+L。',
      parameters: schema({ key: { type: 'string', description: '按键名' } }, ['key']),
      async execute(args) { return channel.press(asString(args, 'key') ?? '') },
    })),
    registry.register(webTool({
      name: 'web_back',
      description: '浏览器后退一页。',
      parameters: schema({}),
      async execute() { return channel.back() },
    })),
    registry.register(webTool({
      name: 'web_screenshot',
      description: '截取当前网页并返回图片路径，用于核对页面是否真的变了（读数与点击优先用 DOM 通道）。',
      parameters: schema({}),
      async execute() { return channel.screenshot() },
    })),
    registry.register(webTool({
      name: 'web_close',
      description: '关闭由插件启动的浏览器（attach 模式只断开连接）。',
      parameters: schema({}),
      async execute() { return channel.close() },
    })),
  ]
  return () => { for (const dispose of disposers) dispose() }
}
