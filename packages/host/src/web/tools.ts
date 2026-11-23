/**
 * The browser channel and its tools.
 *
 * A single persistent browser context per process: the operator's logins survive across
 * conversations, and every tool call talks to the same window. Nothing is launched until the
 * first tool call, so a profile with the switch on but no work never pays for a browser.
 *
 * The tool set is deliberately small and reference-based: a snapshot returns a numbered outline
 * of the visible controls, and clicking or typing uses those numbers. No tool exposes code
 * evaluation, because that is equivalent to running arbitrary code.
 * @module web/tools
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { BrowserContext, Page } from 'playwright-core'
import type { WebSettings } from './settings.ts'

/** One text block as the tool registry renders it. */
interface TextBlock { readonly type: 'text'; readonly text: string }

function block(text: string): TextBlock { return { type: 'text', text } }

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false }
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

/** A control the model may act on, as returned by a snapshot. */
interface SnapshotRow {
  readonly ref: string
  readonly role: string
  readonly name: string
  readonly value?: string
}

/**
 * Holds the single browser context. `executablePath` is always the operator's own choice:
 * nothing is discovered, matched or downloaded implicitly here.
 */
export class BrowserChannel {
  private context: BrowserContext | undefined
  private page: Page | undefined

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

  /** Launch (or attach to) the browser and return the page every tool works on. */
  async ensure(): Promise<Page> {
    if (this.page !== undefined && !this.page.isClosed()) return this.page
    const settings = this.settings()
    // Imported lazily: a profile with the switch off never loads the automation library.
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
    this.page = this.context.pages()[0] ?? (await this.context.newPage())
    return this.page
  }

  /** Where the browser currently is. */
  async status(): Promise<Record<string, unknown>> {
    try {
      const page = await this.ensure()
      return { running: true, url: page.url(), title: await page.title() }
    } catch (error) {
      return { running: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Number the visible controls and return them. Every call replaces the previous numbering,
   * so a ref is only valid for the snapshot that produced it.
   */
  async snapshot(limit = 200): Promise<Record<string, unknown>> {
    const page = await this.ensure()
    const rows = await page.evaluate((max: number): SnapshotRow[] => {
      const selector = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[contenteditable=true]'
      const out: SnapshotRow[] = []
      let index = 0
      for (const element of Array.from(document.querySelectorAll(selector))) {
        const html = element as HTMLElement
        const rect = html.getBoundingClientRect()
        if (rect.width <= 1 || rect.height <= 1) continue
        const style = window.getComputedStyle(html)
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue
        index += 1
        const ref = `e${index}`
        html.setAttribute('data-agi-ref', ref)
        const tag = html.tagName.toLowerCase()
        const role = html.getAttribute('role') ?? tag
        const raw = (html.innerText || html.getAttribute('aria-label') || html.getAttribute('title') || html.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim()
        const name = raw.length > 60 ? `${raw.slice(0, 60)}…` : raw
        const value = html instanceof HTMLInputElement || html instanceof HTMLTextAreaElement || html instanceof HTMLSelectElement
          ? html.value
          : undefined
        out.push(value === undefined ? { ref, role, name } : { ref, role, name, value })
        if (out.length >= max) break
      }
      return out
    }, limit)
    return { url: page.url(), title: await page.title(), controls: rows, count: rows.length }
  }

  private async locatorFor(ref: string) {
    const page = await this.ensure()
    if (!/^e\d+$/.test(ref)) throw new Error(`ref 格式不对：${ref}（应形如 e12，来自最近一次 snapshot）`)
    const locator = page.locator(`[data-agi-ref="${ref}"]`)
    if ((await locator.count()) === 0) throw new Error(`找不到 ${ref}，请重新调用 web_snapshot 拿新的编号。`)
    return locator.first()
  }

  async click(ref: string): Promise<Record<string, unknown>> {
    const target = await this.locatorFor(ref)
    await target.scrollIntoViewIfNeeded()
    await target.click({ timeout: 15_000 })
    const page = await this.ensure()
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined)
    return { ok: true, url: page.url(), title: await page.title() }
  }

  async type(ref: string, text: string, submit: boolean): Promise<Record<string, unknown>> {
    const target = await this.locatorFor(ref)
    await target.scrollIntoViewIfNeeded()
    await target.fill('', { timeout: 15_000 }).catch(async () => { await target.click() })
    await target.type(text, { timeout: 15_000 })
    if (submit) await target.press('Enter')
    const page = await this.ensure()
    if (submit) await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined)
    return { ok: true, url: page.url(), title: await page.title() }
  }

  async press(key: string): Promise<Record<string, unknown>> {
    const page = await this.ensure()
    await page.keyboard.press(key)
    return { ok: true, url: page.url() }
  }

  async navigate(url: string): Promise<Record<string, unknown>> {
    const page = await this.ensure()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    return { ok: true, url: page.url(), title: await page.title() }
  }

  async back(): Promise<Record<string, unknown>> {
    const page = await this.ensure()
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    return { ok: true, url: page.url(), title: await page.title() }
  }

  /** Save a PNG and hand the model its path; the operator can open it too. */
  async screenshot(): Promise<Record<string, unknown>> {
    const page = await this.ensure()
    const dir = join(this.dataDir, 'web-shots')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `web-${Date.now()}.png`)
    writeFileSync(file, await page.screenshot({ type: 'png' }))
    return { ok: true, path: file, url: page.url(), title: await page.title() }
  }

  async close(): Promise<Record<string, unknown>> {
    const context = this.context
    this.context = undefined
    this.page = undefined
    if (context === undefined) return { ok: true, closed: false }
    // attach 模式只断开连接，不关闭操作者自己的浏览器。
    if (this.settings().mode === 'attach') return { ok: true, closed: false, detached: true }
    await context.close().catch(() => undefined)
    return { ok: true, closed: true }
  }
}

/** Register the browser tools; the returned function unregisters them. */
export function registerWebTools(
  registry: { register(tool: unknown): () => void },
  channel: BrowserChannel,
): () => void {
  const disposers = [
    registry.register(webTool({
      name: 'web_open',
      description:
        '打开一个网址（网页 DOM 通道）。打开后调用 web_snapshot 拿控件编号；同一任务的后续网页步骤'
        + '继续用这组工具，不要退回截图逐像素点击。',
      parameters: schema({ url: { type: 'string', description: '完整网址，例如 https://example.com' } }, ['url']),
      async execute(args) {
        const url = asString(args, 'url') ?? ''
        if (!/^https?:\/\//i.test(url)) throw new Error('url 必须以 http:// 或 https:// 开头')
        return channel.navigate(url)
      },
    })),
    registry.register(webTool({
      name: 'web_snapshot',
      description:
        '读取当前页面的标题、地址和可见控件清单（每项带编号 e1、e2…）。点击和输入都用这些编号；'
        + '页面变化后必须重新调用一次，旧编号会失效。',
      parameters: schema({}),
      async execute() { return channel.snapshot() },
    })),
    registry.register(webTool({
      name: 'web_click',
      description: '点击 web_snapshot 返回的某个编号对应控件。',
      parameters: schema({ ref: { type: 'string', description: '控件编号，例如 e12' } }, ['ref']),
      async execute(args) { return channel.click(asString(args, 'ref') ?? '') },
    })),
    registry.register(webTool({
      name: 'web_type',
      description: '往 web_snapshot 返回的输入框写文字；submit 为 true 时写完按回车。',
      parameters: schema({
        ref: { type: 'string', description: '输入框编号，例如 e5' },
        text: { type: 'string', description: '要输入的内容' },
        submit: { type: 'boolean', description: '是否在输入后按回车，默认否' },
      }, ['ref', 'text']),
      async execute(args) {
        return channel.type(asString(args, 'ref') ?? '', asString(args, 'text') ?? '', args.submit === true)
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
      description: '截取当前网页并返回图片路径，用于核对页面是否真的变了。',
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
