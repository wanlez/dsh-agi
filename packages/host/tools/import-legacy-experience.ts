/**
 * One-shot importer: the old markdown experience library → the graph library.
 *
 *   pnpm import:legacy -- --source "D:\\...\\agi经验库" --target "C:\\...\\knowledge-graph"
 *
 * The source is read-only: notes are parsed in memory and screenshots are copied through
 * their bytes, so a cloud-synced library is never touched. Each note becomes one or more
 * nodes; `[名字]` references and the note's own section boundaries become edges; a named
 * path seq
 * becomes an index entry. Every screenshot is copied into `screenshots/<node-id>/` and
 * attached to its node with a caption taken from the step it illustrates.
 *
 * Run it once; a target that already has nodes is refused unless `--force` is passed.
 * `--dry-run` prints the plan and writes nothing.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { KnowledgeGraphService } from '../src/knowledge-graph/service.ts'
import { KnowledgeGraphStore } from '../src/knowledge-graph/store.ts'
import { publishGraphPointer } from '../src/knowledge-graph/library.ts'

/** One parsed markdown note. */
interface Note {
  readonly file: string
  readonly folder: string
  readonly markdown: string
  readonly title: string
  readonly titleLine: number
  readonly lines: readonly string[]
}

/** One part of a node description. */
type Part =
  | { readonly kind: 'all' }
  | { readonly kind: 'section'; readonly heading: string }
  | { readonly kind: 'steps'; readonly heading: string; readonly from: number; readonly to: number }

/** One planned node. */
interface PlanNode {
  readonly key: string
  readonly title: string
  readonly note: string
  readonly parts: readonly Part[]
}

/** The complete import plan distilled from the four legacy notes. */
const PLAN: readonly PlanNode[] = [
  {
    key: 'cloud',
    title: '进入天翼云电脑',
    note: '天翼云电脑/天翼云电脑.md',
    parts: [{ kind: 'all' }],
  },
  {
    key: 'portal',
    title: '打开企业门户并进入薪酬辅助系统',
    note: '发福利/发福利.md',
    parts: [
      { kind: 'section', heading: '### 0.1 前置：先进入云电脑' },
      { kind: 'section', heading: '## 1. 入口' },
      { kind: 'section', heading: '## 2. 界面地图' },
      { kind: 'steps', heading: '## 3. 操作步骤', from: 1, to: 6 },
    ],
  },
  {
    key: 'welfare',
    title: '填写并发送福利积分',
    note: '发福利/发福利.md',
    parts: [
      { kind: 'steps', heading: '## 3. 操作步骤', from: 7, to: Number.MAX_SAFE_INTEGER },
      { kind: 'section', heading: '## 4. 成功 / 失败判断' },
      { kind: 'section', heading: '## 5. 坑' },
      { kind: 'section', heading: '## 6. 权限与审批' },
      { kind: 'section', heading: '## 7. 不要做的事' },
      { kind: 'section', heading: '## 8. 自检' },
    ],
  },
  {
    key: 'mail',
    title: '在 Foxmail 里写邮件',
    note: '发邮件/发邮件.md',
    parts: [
      { kind: 'section', heading: '## 1. 入口' },
      { kind: 'section', heading: '## 2. 界面地图' },
      { kind: 'steps', heading: '## 3. 操作步骤（一步一行）', from: 1, to: 2 },
    ],
  },
  {
    key: 'confirm-mail',
    title: '确认内容并发送邮件',
    note: '发邮件/发邮件.md',
    parts: [
      { kind: 'steps', heading: '## 3. 操作步骤（一步一行）', from: 3, to: Number.MAX_SAFE_INTEGER },
      { kind: 'section', heading: '## 4. 成功 / 失败判断' },
      { kind: 'section', heading: '## 5. 坑' },
      { kind: 'section', heading: '## 6. 权限与审批' },
      { kind: 'section', heading: '## 7. 不要做的事' },
      { kind: 'section', heading: '## 8. 自检' },
    ],
  },
  {
    key: 'rolecard',
    title: '角色卡与图片粘贴测试（2026-10-31）',
    note: '2026-10-31-角色卡与图片粘贴测试.md',
    parts: [{ kind: 'all' }],
  },
]

/** Edges: `from` must be met before `to`. Multiple predecessors are AND. */
const EDGES: readonly (readonly [string, string])[] = [
  // The portal lives inside the cloud desktop, so the desktop comes first.
  ['cloud', 'portal'],
  // Sending welfare points needs the desktop AND the payroll portal open (AND).
  ['cloud', 'welfare'],
  ['portal', 'welfare'],
  // Sending mail also needs the desktop AND a written draft (AND).
  ['cloud', 'mail'],
  ['mail', 'confirm-mail'],
  ['cloud', 'confirm-mail'],
]

/** Saved paths: the execution entry the index lists. */
const PATHS: readonly { readonly name: string; readonly summary: string; readonly sequence: readonly string[] }[] = [
  {
    name: '发福利积分',
    summary: '在天翼云电脑里打开广东电信企业门户的「薪酬辅助系统」，通过「为你点赞 → 关爱传递 → 我要发福利积分」给同事发放福利积分，看到「发送关爱成功~」才算完成。',
    sequence: ['cloud', 'portal', 'welfare'],
  },
  {
    name: '用 Foxmail 发邮件',
    summary: '在天翼云电脑里打开 Foxmail，点「写邮件」填收件人、抄送、主题、正文，逐项和用户确认后再发送。',
    sequence: ['cloud', 'mail', 'confirm-mail'],
  },
  {
    name: '进入天翼云电脑',
    summary: '登录天翼云电脑：账号密码、图形验证码、短信验证码，进入远端 Windows 桌面并确认工具栏延迟正常。',
    sequence: ['cloud'],
  },
  {
    name: '角色卡与图片粘贴测试',
    summary: '2026-10-31 的验证记录：悬浮球角色卡的选择与保存，以及输入框粘贴图片能不能送达模型。',
    sequence: ['rolecard'],
  },
]

/** Which node owns a note's unreferenced screenshots. */
const ORPHAN_OWNER: Readonly<Record<string, string>> = {
  '发邮件/发邮件.md': 'mail',
  '2026-10-31-角色卡与图片粘贴测试.md': 'rolecard',
}

/** One screenshot to copy in. */
interface PlannedShot {
  readonly file: string
  readonly caption: string
}

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

/** Strip the UTF-8 BOM the legacy notes carry. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function readNote(root: string, file: string): Note {
  const absolute = join(root, file)
  const markdown = stripBom(readFileSync(absolute, 'utf8')).replace(/\r\n/gu, '\n')
  const lines = markdown.split('\n')
  const titleLine = lines.findIndex((line) => /^#\s+/u.test(line))
  const title = titleLine === -1 ? basename(file, extname(file)) : lines[titleLine].replace(/^#\s+/u, '').trim()
  return {
    file,
    folder: dirname(absolute),
    markdown,
    title,
    titleLine,
    lines,
  }
}

/** Line range of one heading, stopping at the next heading of the same or higher level. */
function sectionRange(note: Note, heading: string): { start: number; end: number } | undefined {
  const start = note.lines.findIndex((line) => line.trim() === heading.trim())
  if (start === -1) return undefined
  const level = (heading.match(/^#+/u)?.[0] ?? '#').length
  let end = note.lines.length
  for (let index = start + 1; index < note.lines.length; index += 1) {
    const match = /^(#+)\s+/u.exec(note.lines[index])
    if (match !== null && (match[1] as string).length <= level) {
      end = index
      break
    }
  }
  return { start, end }
}

/** Remove image markdown and list bullets, keeping the sentence the screenshot illustrates. */
function cleanLine(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/[*`]/gu, '')
    .replace(/^\s*(?:[-*]|\d+\.)\s+/u, '')
    .replace(/\s+$/u, '')
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/** Render one plan part into prose. */
function renderPart(note: Note, part: Part): string {
  if (part.kind === 'all') {
    const body = note.lines.slice(note.titleLine + 1)
      .filter((line) => !/^\s*>/u.test(line))
      .map(cleanLine)
    return trimBlank(body).join('\n')
  }
  const range = sectionRange(note, part.heading)
  if (range === undefined) return ''
  const body = note.lines.slice(range.start + 1, range.end)
  if (part.kind === 'section') {
    const cleaned = trimBlank(body.filter((line) => !/^\s*>/u.test(line)).map(cleanLine))
    return cleaned.length === 0 ? '' : `${part.heading}\n${cleaned.join('\n')}`
  }
  const steps: string[] = []
  for (const line of body) {
    const match = /^\s*(\d+)\.\s+(.*)$/u.exec(line)
    if (match === null) continue
    const number = Number(match[1])
    if (number < part.from || number > part.to) continue
    steps.push(`${number}. ${cleanLine(match[2] as string)}`)
  }
  if (steps.length === 0) return ''
  return `${part.heading}\n${steps.join('\n')}`
}

function trimBlank(lines: readonly string[]): string[] {
  const copy = [...lines]
  while (copy.length > 0 && (copy[0] as string).trim() === '') copy.shift()
  while (copy.length > 0 && (copy[copy.length - 1] as string).trim() === '') copy.pop()
  const collapsed: string[] = []
  for (const line of copy) {
    if (line.trim() === '' && collapsed[collapsed.length - 1]?.trim() === '') continue
    collapsed.push(line)
  }
  return collapsed
}

/** Build the node description: source line, then every part in order. */
function descriptionOf(note: Note, node: PlanNode): string {
  const chunks: string[] = [`来源笔记：agi经验库/${note.file}`]
  for (const part of node.parts) {
    const rendered = renderPart(note, part)
    if (rendered !== '') chunks.push(rendered)
  }
  return clip(trimBlank(chunks.join('\n\n').split('\n')).join('\n'), 6000)
}

/** Every inline image in a line, with its alt text. */
function imagesInline(line: string): { alt: string; target: string }[] {
  const found: { alt: string; target: string }[] = []
  const pattern = /!\[([^\]]*)\]\(([^)]+)\)/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(line)) !== null) {
    found.push({ alt: (match[1] as string).trim(), target: (match[2] as string).trim() })
  }
  return found
}

/** Caption from the sentence a screenshot sits next to. */
function captionFor(line: string, alt: string, file: string): string {
  const sentence = cleanLine(line).trim()
  if (sentence !== '') return clip(sentence, 80)
  if (alt !== '' && !/^\d+$/u.test(alt)) return clip(alt, 80)
  return clip(`截图 ${file}`, 80)
}

/** Resolve an inline image target relative to the note folder, without leaving it. */
function imagePath(note: Note, target: string): string | undefined {
  const clean = target.split(/[?#]/u)[0] as string
  const absolute = resolve(note.folder, clean)
  if (!absolute.startsWith(resolve(note.folder))) return undefined
  return existsSync(absolute) ? absolute : undefined
}

/** Files in a folder's screenshot store, ignoring other files. */
function screenshotFiles(folder: string): string[] {
  if (!existsSync(folder)) return []
  try {
    return readdirSync(folder)
      .filter((name) => /\.(?:png|jpe?g|webp|gif)$/iu.test(name))
      .sort()
  } catch {
    return []
  }
}

/**
 * Line indices one part owns. A `steps` part owns only its selected step lines, so a
 * screenshot inside step 8 belongs to the node that renders step 8 — not to every node
 * that mentions the same section heading.
 */
function partLineIndices(note: Note, part: Part): number[] {
  if (part.kind === 'all') {
    return note.lines.map((_, index) => index).filter((index) => index > note.titleLine)
  }
  const range = sectionRange(note, part.heading)
  if (range === undefined) return []
  if (part.kind === 'section') {
    const indices: number[] = []
    for (let index = range.start + 1; index < range.end; index += 1) indices.push(index)
    return indices
  }
  const indices: number[] = []
  for (let index = range.start + 1; index < range.end; index += 1) {
    const match = /^\s*(\d+)\.\s+/u.exec(note.lines[index])
    if (match === null) continue
    const number = Number(match[1])
    if (number >= part.from && number <= part.to) indices.push(index)
  }
  return indices
}

/** Planned screenshots for one node: the inline images inside its parts, in document order. */
function shotsFor(note: Note, node: PlanNode): PlannedShot[] {
  const shots: PlannedShot[] = []
  const seen = new Set<string>()
  const owned = new Set<number>()
  for (const part of node.parts) for (const index of partLineIndices(note, part)) owned.add(index)
  for (const index of [...owned].sort((left, right) => left - right)) {
    const line = note.lines[index] as string
    for (const image of imagesInline(line)) {
      const absolute = imagePath(note, image.target)
      if (absolute === undefined) continue
      const file = basename(absolute)
      if (seen.has(file)) continue
      seen.add(file)
      shots.push({ file: absolute, caption: captionFor(line, image.alt, file) })
    }
  }
  return shots
}

/** Turn a bare screenshot file name into a usable caption. */
function captionFromFileName(name: string): string {
  const stem = basename(name, extname(name))
  const trimmed = stem.replace(/^截图\s*\d+\s*[-_.]?\s*/u, '').trim()
  return clip(trimmed === '' ? stem : trimmed, 90)
}

/** Unreferenced files in the note's screenshot folders, with a bullet caption when the note has one. */
function orphanShots(note: Note, referenced: Set<string>): PlannedShot[] {
  const noteStem = basename(note.file, extname(note.file))
  // A note folder keeps screenshots in `screenshots/`; a root-level note uses a sibling
  // `<note>-图/` folder, which is where the 2026-10-31 test record keeps its three images.
  const folders = [join(note.folder, 'screenshots'), join(note.folder, `${noteStem}-图`)]
  const shots: PlannedShot[] = []
  for (const folder of folders) {
    for (const name of screenshotFiles(folder)) {
      if (referenced.has(name)) continue
      const bullet = note.lines.find((line) => /^\s*[-*]\s+/u.test(line) && line.includes(name))
      let caption: string
      if (bullet === undefined) {
        caption = clip(`补充截图：${name}（笔记正文未引用）`, 90)
      } else {
        const text = cleanLine(bullet).trim()
        // The bullet often carries only the file name; the name itself is the caption then.
        caption = text === name || text === basename(name, extname(name))
          ? captionFromFileName(name)
          : clip(text, 90)
      }
      shots.push({ file: join(folder, name), caption })
    }
  }
  return shots
}

async function main(): Promise<void> {
  const sourceRaw = argument('source')
  const targetRaw = argument('target')
  if (sourceRaw === undefined || targetRaw === undefined) {
    console.error('用法：node --experimental-transform-types packages/host/tools/import-legacy-experience.ts --source <旧库目录> --target <图谱库目录> [--dry-run] [--force]')
    process.exit(2)
  }
  const source = resolve(sourceRaw)
  const target = resolve(targetRaw)
  if (!existsSync(source)) {
    console.error(`旧库目录不存在：${source}`)
    process.exit(1)
  }
  const dryRun = flag('dry-run')
  const force = flag('force')

  const notes = new Map<string, Note>()
  const loadNote = (file: string): Note | undefined => {
    const cached = notes.get(file)
    if (cached !== undefined) return cached
    if (!existsSync(join(source, file))) return undefined
    const note = readNote(source, file)
    notes.set(file, note)
    return note
  }

  // Build the full plan before writing anything.
  const plan: { node: PlanNode; note: Note; description: string; shots: PlannedShot[] }[] = []
  const referenced = new Set<string>()
  for (const node of PLAN) {
    const note = loadNote(node.note)
    if (note === undefined) {
      console.warn(`跳过：找不到笔记 ${node.note}`)
      continue
    }
    const description = descriptionOf(note, node)
    const shots = shotsFor(note, node)
    for (const shot of shots) referenced.add(basename(shot.file))
    plan.push({ node, note, description, shots })
  }
  // Unreferenced screenshots go to the note's owner node.
  for (const entry of plan) {
    if (ORPHAN_OWNER[entry.node.note] !== entry.node.key) continue
    const extras = orphanShots(entry.note, referenced)
    for (const extra of extras) referenced.add(basename(extra.file))
    entry.shots.push(...extras)
  }

  console.log(`旧库：${source}`)
  console.log(`新库：${target}`)
  for (const entry of plan) {
    console.log(`  节点「${entry.node.title}」← ${entry.node.note}（${entry.description.length} 字，截图 ${entry.shots.length} 张）`)
    for (const shot of entry.shots) console.log(`      - ${basename(shot.file)}：${shot.caption}`)
  }
  console.log(`  边：${EDGES.map(([from, to]) => `${from}→${to}`).join(' ')}`)
  console.log(`  路径：${PATHS.map((path) => path.name).join(' / ')}`)

  if (dryRun) {
    console.log('dry-run：没有写入任何文件。')
    return
  }

  const store = new KnowledgeGraphStore(target)
  await store.init()
  const before = await new KnowledgeGraphService(store).stats()
  if (before.counts.nodes > 0 && !force) {
    console.error(`目标库已有 ${before.counts.nodes} 个节点；确认要追加请加 --force。`)
    process.exit(1)
  }

  const service = new KnowledgeGraphService(store)
  const ids = new Map<string, string>()
  const written: { key: string; id: string; title: string; screenshots: { file: string; caption: string }[] }[] = []
  try {
    for (const entry of plan) {
      const node = await service.createNode({
        title: entry.node.title,
        description: entry.description,
        created_by: 'legacy-import',
      })
      ids.set(entry.node.key, node.id)
      const shots: { file: string; caption: string }[] = []
      for (const shot of entry.shots) {
        const data = readFileSync(shot.file)
        await service.addScreenshot(node.id, {
          caption: shot.caption,
          data: data.toString('base64'),
          file_name: basename(shot.file),
        })
        shots.push({ file: basename(shot.file), caption: shot.caption })
      }
      written.push({ key: entry.node.key, id: node.id, title: node.title, screenshots: shots })
      console.log(`已建节点 ${node.id}「${node.title}」截图 ${shots.length} 张`)
    }
    for (const [from, to] of EDGES) {
      const fromId = ids.get(from)
      const toId = ids.get(to)
      if (fromId === undefined || toId === undefined) {
        console.warn(`跳过边 ${from}→${to}：节点缺失`)
        continue
      }
      await service.addEdge(fromId, toId)
      console.log(`已建边 ${from}→${to}`)
    }
    const paths: { name: string; id: string; sequence: string[] }[] = []
    for (const path of PATHS) {
      const sequence = path.sequence.map((key) => ids.get(key)).filter((id): id is string => id !== undefined)
      if (sequence.length !== path.sequence.length) {
        console.warn(`跳过路径「${path.name}」：节点缺失`)
        continue
      }
      const created = await service.createPath({ name: path.name, summary: path.summary, node_sequence: sequence })
      paths.push({ name: created.name, id: created.id, sequence: [...created.node_sequence] })
      console.log(`已建路径 ${created.id}「${created.name}」${created.node_sequence.length} 步`)
    }
    const stats = await service.stats()
    const report = {
      generated_at: new Date().toISOString(),
      source,
      target,
      counts: stats.counts,
      nodes: written,
      edges: EDGES.map(([from, to]) => ({ from: ids.get(from) ?? from, to: ids.get(to) ?? to })),
      paths,
      paths_detail: stats.paths.map((path) => ({ name: path.name, runnable: path.runnable, problems: path.problems })),
    }
    const reportFile = join(target, 'import-report.json')
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log('')
    console.log(`导入完成：节点 ${stats.counts.nodes}，边 ${stats.counts.edges}，路径 ${stats.counts.paths}，决策 ${stats.counts.decisions}`)
    console.log(`可执行收藏：${stats.paths.filter((path) => path.runnable).length}/${stats.paths.length}`)
    for (const path of stats.paths) {
      console.log(`  ${path.runnable ? '✓' : '✗'} ${path.name}：${path.node_titles.join(' → ')}${path.runnable ? '' : `（${path.problems.join('；')}）`}`)
    }
    console.log(`报告：${reportFile}`)
    if (flag('publish')) {
      publishGraphPointer(target)
      console.log('已刷新指针：dsh-agi/ACTIVE_GRAPH 与 dsh-agi/ACTIVE_KNOWLEDGE → 新库')
    }
  } catch (error) {
    console.error(`导入失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

await main()
