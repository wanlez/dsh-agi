/**
 * Test-only fixture built from three excerpts of the old Markdown experience library.
 *
 * Nothing here imports into a real library. The test copies the three notes into a
 * temporary graph, verifies index matching → path loading → AND blocker propagation,
 * and removes the temporary directory afterwards.
 *
 * Source notes (outside this repository):
 *   D:\WPS Cloud\WPSDrive\487032007\WPS云盘\AI\agi经验库\天翼云电脑\天翼云电脑.md
 *   D:\WPS Cloud\WPSDrive\487032007\WPS云盘\AI\agi经验库\发福利\发福利.md
 *   D:\WPS Cloud\WPSDrive\487032007\WPS云盘\AI\agi经验库\发邮件\发邮件.md
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url))

/** One node definition the test creates. */
export interface LegacyNode {
  readonly key: string
  readonly title: string
  readonly description: string
}

/** One path definition the test saves. */
export interface LegacyPath {
  readonly key: string
  readonly name: string
  readonly summary: string
  readonly sequence: readonly string[]
}

/** The graph shape distilled from the notes. */
export interface LegacyFixture {
  readonly nodes: readonly LegacyNode[]
  readonly edges: readonly (readonly [string, string])[]
  readonly paths: readonly LegacyPath[]
}

/** Read one fixture note. */
function note(name: string): string {
  return readFileSync(join(FIXTURE_DIR, 'legacy-notes', name), 'utf8')
}

/** The body under one heading, stopping at the next heading. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split(/\r?\n/u)
  const start = lines.findIndex((line) => line.trim() === heading)
  if (start === -1) return ''
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^#{2,3}\s/u.test(line)) break
    body.push(line)
  }
  return body.join('\n').trim()
}

/** The numbered steps inside one section, in order. */
function steps(markdown: string, heading: string): string[] {
  return section(markdown, heading)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s/u.test(line))
}

/** Numbered steps carry their original numbers; join them for a node description. */
function prose(lines: readonly string[]): string {
  return lines.join('\n')
}

/**
 * Build the fixture. The old notes describe a shared cloud-desktop prerequisite and two
 * independent continuations (welfare points and Foxmail); that branch is enough to test
 * index ranking, path loading, and the AND rule without writing anything to the real
 * library.
 */
export function legacyFixture(): LegacyFixture {
  const cloudNote = note('天翼云电脑.md')
  const welfareNote = note('发福利.md')
  const mailNote = note('发邮件.md')

  const cloudDescription = [
    section(cloudNote, '### 3.1 账号密码登录'),
    section(cloudNote, '### 3.2 短信验证（关键步骤）'),
    section(cloudNote, '## 4. 怎么判断成功 / 失败'),
  ].filter((part) => part !== '').join('\n\n')

  const welfareSteps = steps(welfareNote, '## 3. 操作步骤')
  const portalSteps = welfareSteps.slice(0, 6)
  const welfareActionSteps = welfareSteps.slice(6)

  const mailSteps = steps(mailNote, '## 3. 操作步骤（一步一行）')
  const mailOpenSteps = mailSteps.slice(0, 2)
  const mailSendSteps = mailSteps.slice(2)

  return {
    nodes: [
      {
        key: 'cloud',
        title: '进入天翼云电脑',
        description: `登录天翼云电脑并确认进入远端桌面。\n${cloudDescription}`,
      },
      {
        key: 'portal',
        title: '打开企业门户的薪酬辅助系统',
        description: `在云电脑的浏览器里进入 my.gdtel.com。\n${prose(portalSteps)}`,
      },
      {
        key: 'welfare',
        title: '填写并发送福利积分',
        description: `在「关爱传递」页点「我要发福利积分」，填完必填项并确认发送。\n${prose(welfareActionSteps)}\n成功判据：出现绿色对勾和「发送关爱成功~」。`,
      },
      {
        key: 'mail',
        title: '在 Foxmail 里写邮件',
        description: `在云桌面打开 Foxmail，点「写邮件」并填收件人、抄送、主题、正文。\n${prose(mailOpenSteps)}`,
      },
      {
        key: 'confirm-mail',
        title: '确认内容并发送邮件',
        description: `逐项和用户确认后再点发送。\n${prose(mailSendSteps)}\n成功判据：四项内容与用户确认一致，用户同意后发送。`,
      },
    ],
    edges: [
      ['cloud', 'portal'],
      ['portal', 'welfare'],
      ['cloud', 'mail'],
      ['mail', 'confirm-mail'],
      // Two prerequisites on purpose: sending needs the cloud desktop AND a written draft,
      // so the AND rule has something real to block on inside the mail path.
      ['cloud', 'confirm-mail'],
    ],
    paths: [
      {
        key: 'welfare',
        name: '发福利积分',
        summary: '在广东电信企业门户的薪酬辅助系统里，通过「为你点赞 → 关爱传递 → 我要发福利积分」给同事发放福利积分。',
        sequence: ['cloud', 'portal', 'welfare'],
      },
      {
        key: 'email',
        name: '用 Foxmail 发邮件',
        summary: '在天翼云电脑里打开 Foxmail，写邮件并确认收件人、抄送、主题、正文后再发送。',
        sequence: ['cloud', 'mail', 'confirm-mail'],
      },
    ],
  }
}
