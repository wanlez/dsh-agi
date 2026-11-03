/**
 * Character cards for the floating ball.
 *
 * A card is a Markdown file in the harness home's `dsh_agi/personas` folder. The card the
 * user picked is copied into a marked block of the ball's own `AGENTS.md`, which is the
 * workspace the ball's agent runs in — that is what makes the card standing instructions
 * without this plugin owning the system prompt. The marked block is rewritten in place, so
 * anything the user wrote in that file by hand survives.
 *
 * The settings page talks to these helpers through `/.dsh-agi/persona`; the prompt side
 * reads {@link personaForPrompt} on every step.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Longest card body the prompt and the editor accept; a longer file is truncated. */
export const PERSONA_LIMIT = 6000

/** Markers that fence the managed block inside the ball's `AGENTS.md`. */
const PERSONA_START = '<!-- dsh-agi-persona:start -->'
const PERSONA_END = '<!-- dsh-agi-persona:end -->'
/** The selected card is recorded here, next to the profile's other files. */
const PERSONA_FILE = 'agi-persona.json'

/** Which card is on, and whether the shipped cards were already copied once. */
export interface PersonaConfig {
  enabled: boolean
  active: string
  /** True once the built-in cards were seeded; deleting them afterwards sticks. */
  seeded: boolean
}

/** One card the settings page lists. */
export interface PersonaCard {
  readonly name: string
  readonly active: boolean
}

/** What the settings page renders, and what a save answers with. */
export interface PersonaState {
  readonly enabled: boolean
  /** Card name in use, empty when none is selected or the file is gone. */
  readonly active: string
  readonly text: string
  readonly truncated: boolean
  readonly limit: number
  readonly dir: string
  /** The `AGENTS.md` the card is written into. */
  readonly agents: string
  readonly cards: readonly PersonaCard[]
}

/** The folder every card lives in. Shared by all profiles of this machine. */
export function personaDir(): string {
  return join(dshHomePath('dsh_agi'), 'personas')
}

/** The instruction file the ball's agent reads; the card is mirrored into it. */
export function personaAgentsPath(): string {
  return join(dshHomePath('dsh_agi'), 'AGENTS.md')
}

/** The cards shipped inside this package, copied out on first use. */
function personaPresetDir(): string {
  return fileURLToPath(new URL('../persona-presets', import.meta.url))
}

/**
 * Read the selection. A missing or unreadable file keeps every card off until the user
 * picks one. When the file lost its choice, the marker left in `AGENTS.md` is the record
 * of the card that was last written there.
 * @param baseDir - profile directory that holds `agi-persona.json`.
 */
export function readPersonaConfig(baseDir: string): PersonaConfig {
  let config: PersonaConfig = { enabled: true, active: '', seeded: false }
  try {
    const raw = JSON.parse(readFileSync(join(baseDir, PERSONA_FILE), 'utf8')) as {
      enabled?: unknown
      active?: unknown
      seeded?: unknown
    } | null
    config = {
      enabled: raw?.enabled !== false,
      active: typeof raw?.active === 'string' ? raw.active : '',
      seeded: raw?.seeded === true,
    }
  } catch {
    // No file yet: the defaults above are the shipped state.
  }
  if (config.active === '') {
    try {
      const document = readFileSync(personaAgentsPath(), 'utf8')
      const match = /<!-- dsh-agi-persona:name:([^\n]+?) -->/.exec(document)
      if (match !== null) config.active = match[1]?.trim() ?? ''
    } catch {
      // No instruction file either: nothing was ever written.
    }
  }
  return config
}

/** Persist the selection; a failed write only costs the choice, never a throw. */
export function writePersonaConfig(baseDir: string, config: PersonaConfig): void {
  try {
    writeFileSync(join(baseDir, PERSONA_FILE), `${JSON.stringify({
      enabled: config.enabled !== false,
      active: typeof config.active === 'string' ? config.active : '',
      seeded: config.seeded === true,
    }, null, 2)}\n`, 'utf8')
  } catch {
    // The profile may be read-only; the caller still answers with the live state.
  }
}

/**
 * Copy the built-in cards out once, so the settings page has something to show on a
 * fresh install. A card the user deleted later is not put back: the flag is the record.
 * @param baseDir - profile directory that holds the seeded flag.
 */
async function seedPersonaCards(baseDir: string): Promise<void> {
  const config = readPersonaConfig(baseDir)
  if (config.seeded) return
  try {
    const presets = (await readdir(personaPresetDir())).filter((name) => name.toLowerCase().endsWith('.md'))
    await mkdir(personaDir(), { recursive: true })
    for (const name of presets) {
      const target = join(personaDir(), name)
      if (!existsSync(target)) await cp(join(personaPresetDir(), name), target)
    }
    writePersonaConfig(baseDir, { ...config, seeded: true })
  } catch {
    // An install without the preset folder simply starts with no cards.
  }
}

/** Card file names, sorted; `_`-prefixed notes and a README are not cards. */
function personaCards(): string[] {
  try {
    return readdirSync(personaDir())
      .filter((name) => name.toLowerCase().endsWith('.md') && !name.startsWith('_') && name.toLowerCase() !== 'readme.md')
      .sort()
  } catch {
    return []
  }
}

/** Body of one card, empty when the file disappeared between listing and reading. */
export function personaCardText(name: string): string {
  try {
    return readFileSync(join(personaDir(), name), 'utf8')
  } catch {
    return ''
  }
}

/** Turn a typed display name into a file name that cannot leave the persona folder. */
export function safePersonaName(name: string): string {
  const raw = String(name ?? '').trim()
  if (!raw) return ''
  const cleaned = raw.replace(/[\\/:*?"<>|]/g, '').replace(/\.md$/i, '').slice(0, 60).trim()
  return cleaned ? `${cleaned}.md` : ''
}

/**
 * Mirror the active card into `AGENTS.md`. Turning the card off or selecting a missing
 * one removes only the marked block; hand-written instructions around it stay.
 * @param baseDir - profile directory that holds the selection.
 */
function syncPersona(baseDir: string): { enabled: boolean; active: string; text: string; truncated: boolean } {
  const config = readPersonaConfig(baseDir)
  const cards = personaCards()
  const name = config.active !== '' && cards.includes(config.active) ? config.active : ''
  const raw = name ? personaCardText(name) : ''
  const text = raw.length > PERSONA_LIMIT ? raw.slice(0, PERSONA_LIMIT) : raw
  const path = personaAgentsPath()
  let document = ''
  try {
    document = readFileSync(path, 'utf8')
  } catch {
    // A fresh home has no instruction file yet.
  }
  const start = document.indexOf(PERSONA_START)
  const end = document.indexOf(PERSONA_END)
  let base = document
  if (start >= 0 && end > start) base = (document.slice(0, start) + document.slice(end + PERSONA_END.length)).replace(/\s+$/, '')
  const on = config.enabled && text.trim().length > 0
  const marker = on && name ? `<!-- dsh-agi-persona:name:${name} -->\n` : ''
  // Off writes the remainder back without its trailing blank lines, so an idle refresh
  // cannot keep growing the file by one newline per settings visit.
  const next = on
    ? `${base ? `${base}\n\n` : ''}${PERSONA_START}\n${marker}${text}\n${PERSONA_END}\n`
    : `${base ? `${base.replace(/\s+$/, '')}\n` : ''}`
  if (next !== document) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, next, 'utf8')
    } catch {
      // An unwritable home leaves the previous content in place.
    }
  }
  return { enabled: config.enabled, active: name, text, truncated: raw.length > PERSONA_LIMIT }
}

/** Everything the settings card shows, after seeding and re-syncing the instruction file. */
export async function personaState(baseDir: string): Promise<PersonaState> {
  try {
    await mkdir(personaDir(), { recursive: true })
  } catch {
    // Reported through an empty card list below.
  }
  await seedPersonaCards(baseDir)
  const sync = syncPersona(baseDir)
  return {
    enabled: sync.enabled,
    active: sync.active,
    text: sync.text,
    truncated: sync.truncated,
    limit: PERSONA_LIMIT,
    dir: personaDir(),
    agents: personaAgentsPath(),
    cards: personaCards().map((name) => ({ name, active: name === sync.active })),
  }
}

/** Create one empty card file. An existing card is left exactly as it is. */
export async function ensurePersonaCard(name: string): Promise<void> {
  await mkdir(personaDir(), { recursive: true })
  const file = join(personaDir(), name)
  if (!existsSync(file)) await writeFile(file, `# ${name.replace(/\.md$/i, '')}\n\n`, 'utf8')
}

/** Write the editor's body into one card, capped at {@link PERSONA_LIMIT}. */
export async function writePersonaCard(name: string, text: string): Promise<void> {
  await mkdir(personaDir(), { recursive: true })
  await writeFile(join(personaDir(), name), text.slice(0, PERSONA_LIMIT), 'utf8')
}

/** The card body the ball's next step should be told about; empty when the card is off. */
export function personaForPrompt(baseDir: string): string {
  try {
    const config = readPersonaConfig(baseDir)
    if (!config.enabled || config.active === '') return ''
    return personaCardText(config.active).slice(0, PERSONA_LIMIT).trim()
  } catch {
    return ''
  }
}

/** Open the card folder in the system file manager. */
export function openPersonaFolder(): void {
  try {
    const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    spawn(opener, [personaDir()], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    // A missing file manager only costs the button.
  }
}
