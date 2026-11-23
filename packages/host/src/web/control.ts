/**
 * Owns the web-control switch: reads the settings, refuses to start on a remote or virtual
 * desktop, and registers or disposes the browser tools so the switch takes effect without a
 * restart. Nothing here launches a browser; `BrowserChannel` does that on the first tool call.
 * @module web/control
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { detectRemoteEnvironment, type RemoteEnvironment } from './env.ts'
import { defaultWebSettings, mergeWebSettings, readWebSettings, writeWebSettings, type WebSettings } from './settings.ts'
import { BrowserChannel, registerWebTools } from './tools.ts'

/** What the settings page shows about the channel. */
export interface WebState {
  readonly settings: WebSettings
  /** True when the tools are registered right now. */
  readonly active: boolean
  /** Why the channel is off although the switch is on; empty when nothing blocks it. */
  readonly blockedReason: string
  /** The probe evidence, so the operator can judge the detection themselves. */
  readonly evidence: readonly string[]
}

/** A tool registry as the Host exposes it. */
interface ToolRegistry {
  register(tool: unknown): () => void
}

/** The web-control channel: settings, environment gate and tool lifetime. */
export class WebControl {
  private dispose: (() => void) | undefined
  private channel: BrowserChannel | undefined
  /** Probed once, and only after the switch was ever turned on: the probe spawns processes. */
  private env: RemoteEnvironment | undefined

  constructor(
    private readonly registry: ToolRegistry,
    private readonly profileDir: string,
  ) {}

  private environment(): RemoteEnvironment {
    this.env = this.env ?? detectRemoteEnvironment()
    return this.env
  }

  /** The persisted settings, without changing anything. */
  settings(): WebSettings {
    return readWebSettings(this.profileDir)
  }

  /** Register or dispose the tools to match the settings and the environment. */
  refresh(): WebState {
    const settings = this.settings()
    this.stop()
    const env = this.environment()
    if (settings.enabled && !env.blocked) {
      // The channel re-reads the settings per call, so a mode change applies to the next call.
      this.channel = new BrowserChannel(() => readWebSettings(this.profileDir), dshHomePath('dsh-agi', 'web'))
      this.dispose = registerWebTools(this.registry, this.channel)
    }
    return this.state()
  }

  /** Everything the settings page needs, plus the current registration state. */
  state(): WebState {
    const settings = this.settings()
    const active = this.dispose !== undefined
    const env = this.environment()
    const blockedReason = env.blocked
      ? env.reason
      : settings.enabled && !active
        ? '网页通道未能启用，请查看日志'
        : ''
    return { settings, active, blockedReason, evidence: env.evidence }
  }

  /**
   * Apply a partial update from the settings page and make it effective immediately.
   * @param patch - only the fields the operator changed.
   */
  update(patch: Partial<WebSettings>): WebState {
    const next = mergeWebSettings(this.settings() ?? defaultWebSettings(), patch)
    writeWebSettings(this.profileDir, next)
    return this.refresh()
  }

  /** Close the browser (the switch turning off must not leave a window behind). */
  async shutdown(): Promise<void> {
    this.stop()
    await this.channel?.close().catch(() => undefined)
    this.channel = undefined
  }

  private stop(): void {
    this.dispose?.()
    this.dispose = undefined
  }
}
