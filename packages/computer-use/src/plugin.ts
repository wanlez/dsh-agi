/**
 * Register Computer Use tools, policy, and first-frame screenshot attachment.
 * @module @deepseek-ai/dsh-experimental-tool-computer-use/src/plugin
 */

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'computer-use': { kind: 'computer-use' } & ContextFormed
  }
}
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CapturedScreen, ClickButton, DesktopBackend, DesktopForeground, ScreenInfo, ZoomResult } from './backend.ts'
import type { ResolvedComputerUseConfig } from './config.ts'
import {
  coordinateModeOf,
  coordinateOutcome,
  coordinatesRemain,
  firstFrameNotice,
  installCoordinateMode,
  lastAttachedRaster,
  lastObservedWindow,
  rememberObservation,
  toolsForCoordinateMode,
  type CoordinateOutcome,
} from './coordinate-mode.ts'
import {
  assertAllowedHotkey,
  modelPositionToHid,
  requireClickModifiers,
  requireNormalizedPosition,
  requirePixelPosition,
} from './coordinates.ts'
import {
  requireBrowserUrl,
  requireLongPressDuration,
  resolveFinderOpen,
} from './open.ts'
import {
  compactForeground,
  formatForegroundEnvelope,
  observationContent,
  observeDesktop,
  optionalImageFields,
  requireScreen,
  type ObservedScreen,
} from './observe.ts'
import { isUsableObservationRaster } from './raster.ts'
import { policyFor, backgroundPolicyFor } from './policy.ts'
import { assertImageCapableRoute, routeAcceptsImages } from './route.ts'
import { withScreenLock } from './gui-lock.ts'
import { BALL_PRESET, presetOf, screenOwnerId } from './screen-owner.ts'
import { isDesktopSelectionTurn } from './selection-turn.ts'
import { EXTENSION, pairScreenshotFiles, writeScreenshots } from './screenshot.ts'
import { delay } from './wait.ts'
import { LONG_WAIT_SECONDS, WAIT_SECONDS, requireLongWaitSeconds } from './wait-args.ts'

import type {} from './overlay-guard.ts'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used as the first-frame notice producer id. */
export const PLUGIN_NAME = 'tool-computer-use'

/** Prompt section sort order: after PTY guidance, before web search. */
export const POLICY_SECTION_ORDER = 1750

const SCREEN_IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: {
      type: 'string',
      enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      required: true,
    },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
  },
} as const

const SCREEN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    screenIndex: { type: 'integer', required: true },
    logicalWidth: { type: 'number', required: true },
    logicalHeight: { type: 'number', required: true },
    scale: { type: 'number', required: true },
    // The observed window rides along so the next hotkey can hand keyboard focus back to it.
    windowId: { type: 'integer' },
    transientWindowIds: { type: 'array', items: { type: 'integer' } },
    appName: { type: 'string' },
    image: SCREEN_IMAGE_SCHEMA,
  },
} as const

const SCREENS_FIELD = {
  type: 'array',
  required: true,
  items: SCREEN_SCHEMA,
} as const

const FOREGROUND_FIELD = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    appName: { type: 'string', required: true },
    windowTitle: { type: 'string' },
    finderFolder: { type: 'string' },
    focusNote: { type: 'string' },
  },
} as const

const COORDINATE_FIELDS = {
  coordinateMode: {
    type: 'string',
    required: true,
    enum: ['millifraction', 'pixel'],
  },
  attachedWidth: { type: 'integer' },
  attachedHeight: { type: 'integer' },
} as const

function genericExecute(title: string, rawInput: unknown): GenericCallView {
  return { card: 'generic', title, kind: 'execute', rawInput }
}

function resultBlocks(
  intro: string,
  screens: readonly ObservedScreen[],
  foreground: DesktopForeground,
  outcome: CoordinateOutcome,
): ContentBlock[] {
  return [{ type: 'text', text: intro }, ...observationContent(screens, foreground, outcome.coordinateMode)]
}

function sessionOf(exec: ToolExecution): Session | undefined {
  return exec.agent?.session
}

function validatedPosition(exec: ToolExecution, position: readonly number[]): [number, number] {
  const session = sessionOf(exec)
  const mode = coordinateModeOf(session)
  if (mode === 'millifraction') return requireNormalizedPosition(position)
  const attached = lastAttachedRaster(session)
  if (attached === undefined) {
    throw new Error('computer-use: pixel coordinates require an attached screenshot raster')
  }
  return requirePixelPosition(position, attached)
}

function hidPosition(exec: ToolExecution, position: readonly number[]): [number, number] {
  const session = sessionOf(exec)
  const mode = coordinateModeOf(session)
  return modelPositionToHid(position, mode, mode === 'pixel' ? lastAttachedRaster(session) : undefined)
}

function observedFields(
  session: Session | undefined,
  observation: { screens: ObservedScreen[]; foreground: DesktopForeground },
): {
  screens: ObservedScreen[]
  foreground: DesktopForeground
} & CoordinateOutcome {
  return {
    screens: observation.screens,
    foreground: observation.foreground,
    ...coordinateOutcome(session, observation.screens),
  }
}

async function recapture(
  ctx: Context,
  backend: DesktopBackend,
  exec: ToolExecution,
  settleMs = 0,
): Promise<{
  screens: ObservedScreen[]
  foreground: DesktopForeground
  captures: CapturedScreen[]
}> {
  const session = sessionOf(exec)
  const mode = coordinateModeOf(session)
  const observation = await observeDesktop(ctx, backend, exec.signal, {
    settleMs,
    coordinateMode: mode,
  })
  rememberObservation(session, observation.screens)
  return {
    screens: [...observation.screens],
    foreground: compactForeground(observation.foreground),
    captures: [...observation.captures],
  }
}

/**
 * Hold the cross-session screen lock and overlay click-through across one HID or activate call and
 * its recapture. Contention from another Computer Use session fails fast before any cloak IPC.
 * @param backend - desktop backend; Desktop wrap maps this to overlay-guard `withInput`.
 * @param exec - tool execution; its agent id owns the lock and its signal cancels the action.
 * @param run - HID plus recapture.
 * @returns the value `run` resolves to.
 */
function guiTurn<T>(
  backend: DesktopBackend,
  exec: ToolExecution,
  run: () => Promise<T>,
): Promise<T> {
  return withScreenLock(exec.agent?.id, () => backend.withGuiTurn(run, exec.signal))
}

function screenshotIntro(paths: readonly string[], outcome: CoordinateOutcome): string {
  const first = paths[0]
  const saved = first === undefined
    ? 'Screenshot captured (no file kept; pass save_dir to keep one copy)'
    : `Saved screenshot to ${first}`
  return `${saved} and copied it to the clipboard. The image is ready to paste. ${coordinatesRemain(outcome)}`
}

function clickResultText(value: {
  readonly screenIndex: number
  readonly position: readonly number[]
  readonly button: string
  readonly count: number
  readonly confirmed?: boolean
  readonly zoomLevel?: number
  readonly modifiers?: readonly string[]
} & CoordinateOutcome): string {
  const mods = value.modifiers === undefined
    ? ''
    : `, modifiers ${value.modifiers.join(', ')}`
  if (value.confirmed === false) return previewText(value, 'click')
  return `Clicked screen ${String(value.screenIndex)} at [${value.position.join(', ')}] (${value.button}, count ${String(value.count)}${mods}). ${coordinatesRemain(value)}`
}

/** Per-session two-stage aiming state: last zoom crop and the point it centered on. */
interface PointerZoomState {
  /** Zoom level of the preview that produced {@link rect}: 1 is the window, 2 is the close crop. */
  level: number
  /** Last zoom crop in physical screen pixels; screen 1 aims inside it. */
  rect: { x: number; y: number; width: number; height: number }
  /** Pixel point the crop was taken around, replayed when the action is confirmed. */
  pending?: { x: number; y: number }
  /** Window the crop belongs to; a preview from another window is refused. */
  windowId: number | undefined
  /** Tool the preview was made for, so a click preview cannot confirm a drag. */
  tool: string
  /** Local timestamp of the preview; an old crop is refused. */
  at: number
}

const pointerZoomState = new WeakMap<Session, PointerZoomState>()

/**
 * Screen that maps a normalized position onto one exact pixel point.
 * The backend maps fractions against bounds, so a 1000-wide box at the point with [0, 0]
 * resolves to the point itself.
 * @param point - pixel point to act on.
 * @param windowId - window the point belongs to, when the observation has one.
 * @param scale - backing-store scale reported to the model.
 * @returns a one-use screen envelope for a HID call.
 */
function pointScreenAt(point: { readonly x: number; readonly y: number }, windowId: number | undefined, scale: number): ScreenInfo {
  return {
    index: 0,
    bounds: { x: point.x, y: point.y, width: 1000, height: 1000 },
    scale,
    ...windowId === undefined ? {} : { windowId },
  }
}

/**
 * Resolve the coordinate reference for a pointer action: screen 0 is the whole window,
 * screen 1 is the zoom crop returned by the previous preview.
 * @param session - session whose last preview is reused for screen 1.
 * @param screens - current backend surface list.
 * @param screenIndex - model-supplied index.
 * @returns the window screen, the reference the position is measured on, and the next zoom level.
 * @throws when screen 1 is requested without a live preview.
 */
function pointerReference(
  session: Session | undefined,
  screens: readonly ScreenInfo[],
  screenIndex: number,
): { windowScreen: ScreenInfo; reference: ScreenInfo; level: number } {
  const windowScreen = requireScreen(screens, 0)
  if (screenIndex !== 1) return { windowScreen, reference: windowScreen, level: 1 }
  const state = session === undefined ? undefined : pointerZoomState.get(session)
  if (state === undefined) throw new Error('computer-use: screen 1 is unavailable; preview on screen 0 first')
  if (Date.now() - state.at > 60_000) throw new Error('computer-use: the zoom preview is stale; preview again on screen 0')
  if (state.windowId !== undefined && windowScreen.windowId !== undefined && state.windowId !== windowScreen.windowId) {
    throw new Error('computer-use: the window changed; preview again')
  }
  return {
    windowScreen,
    reference: {
      index: 1,
      bounds: state.rect,
      scale: state.level,
      ...windowScreen.windowId === undefined ? {} : { windowId: windowScreen.windowId },
    },
    level: Math.min(2, state.level + 1),
  }
}

/**
 * Move the pointer to a target and build the shared pre-action zoom (single-stage).
 * With `confirm` false the caller returns the preview instead of acting.
 * @param ctx - plugin context with `attachments`.
 * @param exec - tool execution; its session owns the zoom state.
 * @param backend - desktop backend.
 * @param screen - screen the position is measured on.
 * @param pointPosition - pointer position in HID units.
 * @param confirm - true to act, false to preview.
 * @returns the zoom screen for a confirm, or the preview screens and foreground.
 */
async function beginPointerAction(
  ctx: Context,
  exec: ToolExecution,
  backend: DesktopBackend,
  screen: ScreenInfo,
  pointPosition: readonly [number, number],
  confirm: boolean,
): Promise<
  | { confirmed: true; zoomScreen: ObservedScreen | undefined }
  | { confirmed: false; screens: ObservedScreen[]; foreground: DesktopForeground }
> {
  let zoom: ZoomResult | undefined
  try {
    const capture = backend.zoom
    if (capture !== undefined) zoom = await capture({ screen, position: pointPosition })
  } catch {
    // A platform without zoom still acts; the preview simply has no crop.
  }
  let zoomScreen: ObservedScreen | undefined
  if (zoom !== undefined) {
    try {
      const saved = await ctx.attachments.saveImage({
        data: zoom.data,
        mediaType: zoom.mediaType,
        name: 'pointer-zoom',
      })
      zoomScreen = {
        screenIndex: 1,
        logicalWidth: zoom.rect.width,
        logicalHeight: zoom.rect.height,
        scale: screen.scale,
        ...screen.windowId === undefined ? {} : { windowId: screen.windowId },
        image: {
          attachmentId: saved.attachmentId,
          mediaType: saved.mediaType,
          bytes: saved.bytes,
          width: saved.width,
          height: saved.height,
          ...optionalImageFields(saved),
        },
      }
    } catch {
      // The crop is a convenience; a failed attachment store must not fail the action.
    }
  }
  if (confirm) return { confirmed: true, zoomScreen }
  const preview = await recapture(ctx, backend, exec, 0)
  const screens = [...preview.screens]
  if (zoomScreen !== undefined) screens.push(zoomScreen)
  return { confirmed: false, screens, foreground: preview.foreground }
}

/** Outcome of one two-stage aiming step. */
type PointerPreview =
  | { confirmed: true; target: { x: number; y: number }; windowScreen: ScreenInfo }
  | { confirmed: false; screens: ObservedScreen[]; foreground: DesktopForeground; level: number }

/**
 * Two-stage aiming for click-like actions: screen 0 aims on the window, screen 1 aims
 * inside the previous zoom crop and doubles the zoom for finer work.
 * With `confirm` false the caller returns the preview instead of acting.
 * @param ctx - plugin context with `attachments`.
 * @param exec - tool execution; its session owns the zoom state.
 * @param backend - desktop backend.
 * @param screens - current backend surface list.
 * @param screenIndex - model-supplied index; 1 aims inside the last crop.
 * @param pointPosition - pointer position in HID units.
 * @param confirm - true to act at the last previewed point, false to preview.
 * @param tool - tool name the preview belongs to.
 * @returns the confirmed point, or the preview screens and foreground.
 */
async function previewPointerAction(
  ctx: Context,
  exec: ToolExecution,
  backend: DesktopBackend,
  screens: readonly ScreenInfo[],
  screenIndex: number,
  pointPosition: readonly [number, number],
  confirm: boolean,
  tool: string,
): Promise<PointerPreview> {
  const session = sessionOf(exec)
  const state = session === undefined ? undefined : pointerZoomState.get(session)
  if (confirm) {
    if (state === undefined || state.pending === undefined) {
      throw new Error('computer-use: preview this action first, then confirm')
    }
    if (state.tool !== tool) {
      throw new Error('computer-use: the last preview was for a different action; preview again')
    }
    return { confirmed: true, target: state.pending, windowScreen: requireScreen(screens, 0) }
  }
  const resolved = pointerReference(session, screens, screenIndex)
  const capture = backend.zoom
  if (capture === undefined) throw new Error('computer-use: this platform cannot zoom; preview is unavailable')
  const windowHeight = resolved.windowScreen.bounds.height
  const side = Math.max(24, Math.round(windowHeight / (6 * 2 ** (resolved.level - 1))))
  const zoom = await capture({
    screen: resolved.reference,
    position: pointPosition,
    side,
    clamp: resolved.windowScreen.bounds,
  })
  let zoomScreen: ObservedScreen | undefined
  try {
    const saved = await ctx.attachments.saveImage({
      data: zoom.data,
      mediaType: zoom.mediaType,
      name: 'pointer-zoom',
    })
    zoomScreen = {
      screenIndex: 1,
      logicalWidth: zoom.rect.width,
      logicalHeight: zoom.rect.height,
      scale: resolved.windowScreen.scale,
      ...resolved.windowScreen.windowId === undefined ? {} : { windowId: resolved.windowScreen.windowId },
      image: {
        attachmentId: saved.attachmentId,
        mediaType: saved.mediaType,
        bytes: saved.bytes,
        width: saved.width,
        height: saved.height,
        ...optionalImageFields(saved),
      },
    }
  } catch {
    // The crop is a convenience; a failed attachment store must not fail the preview.
  }
  if (session !== undefined) {
    pointerZoomState.set(session, {
      level: resolved.level,
      rect: zoom.rect,
      pending: zoom.point,
      windowId: resolved.windowScreen.windowId,
      tool,
      at: Date.now(),
    })
  }
  const preview = await recapture(ctx, backend, exec, 0)
  const previewScreens = [...preview.screens]
  if (zoomScreen !== undefined) previewScreens.push(zoomScreen)
  return {
    confirmed: false,
    screens: previewScreens,
    foreground: preview.foreground,
    level: resolved.level,
  }
}

/**
 * Text for a pointer action that stopped at the preview step.
 * @param value - preview result; only its zoom level is read.
 * @param what - action the model asked for, named in the refusal.
 * @returns the model-facing explanation of the preview and how to confirm.
 */
function previewText(value: { readonly zoomLevel?: number | undefined }, what: string): string {
  const base = `Preview only — no ${what} was performed. Screen 1 is a zoom around the pointer; its crosshair marks the exact point you are about to act on.`
  if (value.zoomLevel === undefined || value.zoomLevel <= 0) return base
  if (value.zoomLevel >= 2) {
    return `${base} This is the closest zoom (level 2, window height / 12): confirm to act there, or nudge the position by a few units if the crosshair is off.`
  }
  return `${base} To aim more precisely, call the same tool with screen_index=1 and a position measured on that crop; that previews the close zoom (window height / 12). When the crosshair sits on the target, confirm=true.`
}

/** One pointer tool step: either a finished preview result or the confirmed pixel point. */
type PointerGate<P extends object> =
  | { done: true; result: P & { confirmed: false; zoomLevel: number } & ReturnType<typeof observedFields> }
  | { done: false; point: { x: number; y: number }; windowScreen: ScreenInfo }

/**
 * Run one pointer tool step through the shared two-stage aiming flow.
 * A preview returns a ready-to-render result; a confirm returns the exact point.
 * @param ctx - plugin context with `attachments`.
 * @param exec - tool execution; its session owns the zoom state.
 * @param backend - desktop backend.
 * @param options - screen index, HID position, confirm flag, and tool name.
 * @param preview - tool-specific fields attached to the preview result.
 * @returns a finished preview result, or the point to act on.
 */
async function runPointerAction<P extends object>(
  ctx: Context,
  exec: ToolExecution,
  backend: DesktopBackend,
  options: { screenIndex: number; position: readonly [number, number]; confirm: boolean; tool: string },
  preview: P,
): Promise<PointerGate<P>> {
  const screens = await backend.listScreens(exec.signal)
  const gate = await previewPointerAction(
    ctx,
    exec,
    backend,
    screens,
    options.screenIndex,
    options.position,
    options.confirm,
    options.tool,
  )
  if (!gate.confirmed) {
    return {
      done: true,
      result: {
        ...preview,
        confirmed: false,
        zoomLevel: gate.level,
        ...observedFields(sessionOf(exec), { screens: gate.screens, foreground: gate.foreground }),
      },
    }
  }
  return { done: false, point: gate.target, windowScreen: gate.windowScreen }
}

/**
 * Register the exclusive GUI tools, the policy section, and first-frame screenshot attachment.
 * @param ctx - registration scope; requires `tools`, `systemPrompt`, and `attachments`.
 * @param backend - desktop capture and input.
 * @param config - resolved tunables.
 */
export function applyComputerUse(
  ctx: Context,
  backend: DesktopBackend,
  config: ResolvedComputerUseConfig,
): void {
  installCoordinateMode(ctx)
  ctx.systemPrompt.section({
    name: 'tool:computer-use',
    order: POLICY_SECTION_ORDER,
    text: (context) => {
      // Ownership is read per assembly, so a conversation that becomes — or stops being — the one
      // the ball shows gets the matching capability text on its very next request. Two doors stay
      // open: an absent owner is the unrestricted case (web, CLI, ball switched off), and a session
      // that is not a ball conversation keeps the full policy whatever the owner is.
      const agent = context.agent
      const owner = screenOwnerId()
      if (agent !== undefined && owner !== undefined && owner !== agent.id && presetOf(agent) === BALL_PRESET) {
        return backgroundPolicyFor()
      }
      return policyFor(coordinateModeOf(agent?.session))
    },
  })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const nextAssembly = await next()
    const mode = coordinateModeOf(context.agent?.session)
    if (mode === 'millifraction') return nextAssembly
    return { ...nextAssembly, tools: toolsForCoordinateMode(nextAssembly.tools, mode) }
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'turn/end') return
    const guard = ctx.get('computerUseOverlayGuard')
    if (guard === undefined) return
    void guard.setObservationFrame(null).catch(() => {
      // Host IPC already gone or observation-frame ack timed out; hide is best-effort after turn/end.
    })
  })

  ctx.tools.register(defineTool({
    name: 'click',
    description:
      'Two-step click with two-stage aiming. Without confirm it moves the pointer and returns a zoomed crop '
      + '(screen 1) of the target. On that crop, call again with screen_index=1 and a position measured inside the '
      + 'crop to aim finer: the second preview zooms to window height / 12 and the crosshair marks the exact point '
      + 'under the pointer. confirm=true clicks at the point the last preview settled on, then returns the '
      + 'post-action screenshot. Use left (default) or right button; count 2 is a double-click. '
      + 'Optional modifiers (shift, cmd, option, control) are held only for this click.',
    parameters: {
      screen_index: { type: 'integer', required: true, description: '0 for the attached frontmost-window screenshot.' },
      position: {
        type: 'array',
        required: true,
        items: { type: 'number' },
        description: '[x, y] as a 0–1000 fraction of that screenshot, not pixels.',
      },
      button: {
        type: 'string',
        enum: ['left', 'right'],
        default: 'left',
        description: 'Mouse button. Default: left.',
      },
      count: {
        type: 'integer',
        enum: [1, 2],
        default: 1,
        description: '1 for a single click, 2 for a double-click. Default: 1.',
      },
      modifiers: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Modifier keys held only for this click, for example ["shift"] or ["cmd"]. Omit for a plain click.',
      },
      confirm: {
        type: 'boolean',
        default: false,
        description:
          'false (default) previews only: moves the pointer to the target and returns a zoomed crop without '
          + 'clicking. Pass true to actually click after checking the crop.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          screenIndex: { type: 'integer', required: true },
          position: { type: 'array', required: true, items: { type: 'number' } },
          button: { type: 'string', required: true, enum: ['left', 'right'] },
          count: { type: 'integer', required: true },
          confirmed: { type: 'boolean', required: true },
          zoomLevel: { type: 'number' },
          modifiers: { type: 'array', items: { type: 'string' } },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD,
        },
      },
      render: (_args, value) => resultBlocks(
        clickResultText(value),
        value.screens,
        value.foreground,
        value,
      ),
    },
    isConcurrencySafe: () => false,
    presentCall: args => genericExecute('Click', {
      screen_index: args.screen_index,
      position: args.position,
      ...args.modifiers !== undefined && args.modifiers.length > 0 ? { modifiers: args.modifiers } : {},
    }),
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec)
      const position = validatedPosition(exec, args.position)
      const button: ClickButton = args.button === 'right' ? 'right' : 'left'
      const count: 1 | 2 = args.count === 2 ? 2 : 1
      const modifiers = requireClickModifiers(args.modifiers)
      const confirm = args.confirm === true
      return guiTurn(backend, exec, async () => {
        const gate = await runPointerAction(ctx, exec, backend, {
          screenIndex: args.screen_index,
          position: hidPosition(exec, position),
          confirm,
          tool: 'click',
        }, {
          screenIndex: args.screen_index,
          position,
          button,
          count,
          ...modifiers === undefined ? {} : { modifiers },
        })
        if (gate.done) return gate.result
        await backend.click({
          screen: pointScreenAt(gate.point, gate.windowScreen.windowId, 1),
          position: [0, 0],
          button,
          count,
          ...modifiers === undefined ? {} : { modifiers },
        }, exec.signal)
        const observation = await recapture(ctx, backend, exec, config.postActionWaitMs)
        return {
          screenIndex: args.screen_index,
          position,
          button,
          count,
          confirmed: true,
          ...modifiers === undefined ? {} : { modifiers },
          ...observedFields(sessionOf(exec), observation),
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'input_text',
    description:
      'Two-step text entry with two-stage aiming. Without confirm it moves the pointer and returns a zoomed crop '
      + '(screen 1) of the target. On that crop, call again with screen_index=1 and a position measured inside the '
      + 'crop to zoom to window height / 12. confirm=true focuses the field and types at the point the last preview '
      + 'settled on, then returns the post-action screenshot. replace selects all first; submit presses Enter '
      + 'after typing.',
    parameters: {
      screen_index: { type: 'integer', required: true, description: '0 for the attached frontmost-window screenshot.' },
      position: {
        type: 'array',
        required: true,
        items: { type: 'number' },
        description: '[x, y] as a 0–1000 fraction of that screenshot, not pixels; the click focuses the field.',
      },
      text: { type: 'string', required: true, description: 'Characters to type after the focus click.' },
      replace: {
        type: 'boolean',
        default: false,
        description: 'When true, select all in the focused field before typing. Default: false.',
      },
      submit: {
        type: 'boolean',
        default: false,
        description: 'When true, press Enter after typing. Default: false.',
      },
      confirm: {
        type: 'boolean',
        default: false,
        description:
          'false (default) previews only: moves the pointer to the field and returns a zoomed crop without '
          + 'typing. Pass true to focus and type after checking the crop.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          screenIndex: { type: 'integer', required: true },
          position: { type: 'array', required: true, items: { type: 'number' } },
          text: { type: 'string', required: true },
          replace: { type: 'boolean', required: true },
          submit: { type: 'boolean', required: true },
          confirmed: { type: 'boolean', required: true },
          zoomLevel: { type: 'number' },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD,
        },
      },
      render: (_args, value) => resultBlocks(
        value.confirmed === false
          ? previewText(value, 'text entry')
          : `Typed on screen ${String(value.screenIndex)} at [${value.position.join(', ')}] (replace=${String(value.replace)}, submit=${String(value.submit)}). ${coordinatesRemain(value)}`,
        value.screens,
        value.foreground,
        value,
      ),
    },
    isConcurrencySafe: () => false,
    presentCall: args => genericExecute('Type text', { screen_index: args.screen_index, text: args.text }),
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec)
      const position = validatedPosition(exec, args.position)
      const replace = args.replace ?? false
      const submit = args.submit ?? false
      const confirm = args.confirm === true
      return guiTurn(backend, exec, async () => {
        const gate = await runPointerAction(ctx, exec, backend, {
          screenIndex: args.screen_index,
          position: hidPosition(exec, position),
          confirm,
          tool: 'input_text',
        }, {
          screenIndex: args.screen_index,
          position,
          text: args.text,
          replace,
          submit,
        })
        if (gate.done) return gate.result
        await backend.typeText({
          screen: pointScreenAt(gate.point, gate.windowScreen.windowId, 1),
          position: [0, 0],
          text: args.text,
          replace,
          submit,
        }, exec.signal)
        const observation = await recapture(ctx, backend, exec, config.postActionWaitMs)
        return {
          screenIndex: args.screen_index,
          position,
          text: args.text,
          replace,
          submit,
          confirmed: true,
          ...observedFields(sessionOf(exec), observation),
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'scroll',
    description:
      'Scroll up or down at a 0–1000 position on the attached frontmost-window screenshot, then return the post-action screenshot. scroll_level is 1–10.',
    parameters: {
      screen_index: { type: 'integer', required: true, description: '0 for the attached frontmost-window screenshot.' },
      position: {
        type: 'array',
        required: true,
        items: { type: 'number' },
        description: '[x, y] as a 0–1000 fraction of that screenshot, not pixels.',
      },
      direction: {
        type: 'string',
        required: true,
        enum: ['up', 'down'],
        description: 'Scroll direction.',
      },
      scroll_level: {
        type: 'integer',
        required: true,
        description: 'Scroll magnitude from 1 (smallest) to 10 (largest).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          screenIndex: { type: 'integer', required: true },
          position: { type: 'array', required: true, items: { type: 'number' } },
          direction: { type: 'string', required: true, enum: ['up', 'down'] },
          scrollLevel: { type: 'integer', required: true },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD,
        },
      },
      render: (_args, value) => resultBlocks(
        `Scrolled ${value.direction} on screen ${String(value.screenIndex)} at [${value.position.join(', ')}] (level ${String(value.scrollLevel)}). ${coordinatesRemain(value)}`,
        value.screens,
        value.foreground,
        value,
      ),
    },
    isConcurrencySafe: () => false,
    presentCall: args => genericExecute('Scroll', {
      screen_index: args.screen_index,
      direction: args.direction,
      scroll_level: args.scroll_level,
    }),
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec)
      const position = validatedPosition(exec, args.position)
      if (!Number.isInteger(args.scroll_level) || args.scroll_level < 1 || args.scroll_level > 10) {
        throw new Error('scroll_level must be an integer from 1 to 10')
      }
      return guiTurn(backend, exec, async () => {
        const screens = await backend.listScreens(exec.signal)
        const screen = requireScreen(screens, args.screen_index)
        await backend.scroll({
          screen,
          position: hidPosition(exec, position),
          direction: args.direction,
          scrollLevel: args.scroll_level,
        }, exec.signal)
        const observation = await recapture(ctx, backend, exec, config.postActionWaitMs)
        return {
          screenIndex: args.screen_index,
          position,
          direction: args.direction,
          scrollLevel: args.scroll_level,
          ...observedFields(sessionOf(exec), observation),
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hotkey',
    description:
      'Press a key combination on the desktop, then return the post-action screenshot. '
      + 'System screenshot shortcuts (Cmd/Win+Shift+3/4/5) are rejected.',
    parameters: {
      keys: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Key names in order, for example ["cmd", "c"].',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          keys: { type: 'array', required: true, items: { type: 'string' } },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD,
        },
      },
      render: (_args, value) => resultBlocks(
        `Pressed hotkey [${value.keys.join(', ')}]. ${coordinatesRemain(value)}`,
        value.screens,
        value.foreground,
        value,
      ),
    },
    isConcurrencySafe: () => false,
    presentCall: args => genericExecute('Hotkey', args.keys),
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec)
      if (args.keys.length === 0) throw new Error('keys must contain at least one key')
      assertAllowedHotkey(args.keys)
      return guiTurn(backend, exec, async () => {
        // The keys go to the window this session last observed, not to whatever capture ran
        // most recently (which may belong to another session).
        const observed = lastObservedWindow(sessionOf(exec))
        await backend.hotkey({
          keys: args.keys,
          ...observed === undefined ? {} : observed,
        }, exec.signal)
        const observation = await recapture(ctx, backend, exec, config.postActionWaitMs)
        return {
          keys: args.keys,
          ...observedFields(sessionOf(exec), observation),
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wait',
    description:
      'Pause 1 second, then return a fresh frontmost-window screenshot without moving the pointer. '
      + 'Use for page refresh, a loader, or a control that has not appeared yet. '
      + 'Do not use for code_agent.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          waitSeconds: { type: 'number', required: true },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD,
        },
      },
      render: (_args, value) => resultBlocks(
        `Waited ${String(value.waitSeconds)}s. ${coordinatesRemain(value)}`,
        value.screens,
        value.foreground,
        value,
      ),
    },
    isConcurrencySafe: () => false,
    presentCall: () => genericExecute('Wait', WAIT_SECONDS),
    async execute(_args, exec) {
      await assertImageCapableRoute(ctx, exec)
      await delay(WAIT_SECONDS * 1000, exec.signal)
      const observation = await recapture(ctx, backend, exec)
      return {
        waitSeconds: WAIT_SECONDS,
        ...observedFields(sessionOf(exec), observation),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'long_wait',
    description:
      'Pause 10, 30, 60, or 120 seconds, then return a fresh frontmost-window screenshot without moving the pointer. '
      + 'Only for a visible long job such as a download, installer, export, or on-screen generation. '
      + 'Pick the smallest wait_seconds that covers remaining progress; 120 only when the screenshot already shows a minutes-long job. '
      + 'Ordinary loading uses wait. Do not use for code_agent.',
    parameters: {
      wait_seconds: {
        type: 'integer',
        required: true,
        enum: [...LONG_WAIT_SECONDS],
        description: 'Seconds to pause. Must be 10, 30, 60, or 120.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          waitSeconds: { type: 'number', required: true },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD,
        },
      },
      render: (_args, value) => resultBlocks(
        `Waited ${String(value.waitSeconds)}s. ${coordinatesRemain(value)}`,
        value.screens,
        value.foreground,
        value,
      ),
    },
    isConcurrencySafe: () => false,
    presentCall: args => genericExecute('Long wait', args.wait_seconds),
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec)
      const waitSeconds = requireLongWaitSeconds(args.wait_seconds)
      await delay(waitSeconds * 1000, exec.signal)
      const observation = await recapture(ctx, backend, exec)
      return {
        waitSeconds,
        ...observedFields(sessionOf(exec), observation),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'screenshot',
    description:
      'Capture the current frontmost-window screenshot and copy it to the clipboard. By default no file is kept; '
      + 'pass save_dir to keep exactly one copy there (identical images are skipped). Use when the user asked for '
      + 'a screenshot file, when saving a playbook step (pass the playbook\'s screenshots folder), or when the '
      + 'image is needed on the clipboard. After bash, search, or web_fetch, call this to refresh the frontmost '
      + 'window. After click, type, wait, or open, do not call it again — those results already attach a window.',
    parameters: {
      save_dir: {
        type: 'string',
        description: 'Optional directory that keeps one copy of the screenshot. Omit to keep no file.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paths: { type: 'array', required: true, items: { type: 'string' } },
          clipboard: { type: 'boolean', required: true },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD,
        },
      },
      render: (_args, value) => resultBlocks(
        screenshotIntro(value.paths, value),
        value.screens,
        value.foreground,
        value,
      ),
    },
    isConcurrencySafe: () => false,
    presentCall: () => genericExecute('Screenshot', {}),
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec)
      const session = sessionOf(exec)
      const observation = await observeDesktop(ctx, backend, exec.signal, {
        coordinateMode: coordinateModeOf(session),
        persistCapture: captured => isUsableObservationRaster(captured.data),
      })
      const foreground = compactForeground(observation.foreground)
      if (observation.screens.length === 0) {
        if (observation.captures.length > 0) {
          throw new Error(
            `computer-use: screenshot capture was unusable. Retry screenshot, wait, or open_app.\n${formatForegroundEnvelope(foreground)}`,
          )
        }
        throw new Error('computer-use: screenshot produced no files')
      }
      rememberObservation(session, observation.screens)
      const files = pairScreenshotFiles(observation.captures, observation.screens)
      const first = files[0]
      if (first === undefined) throw new Error('computer-use: screenshot produced no files')
      const paths = await writeScreenshots(files, {
        ...typeof args.save_dir === 'string' ? { dir: args.save_dir } : {},
      })
      // The clipboard needs a real file on Windows; use a scratch copy that is removed again
      // so a clipboard-only screenshot leaves nothing behind in the user's folders.
      const tempDir = await mkdtemp(join(tmpdir(), 'dsh-agi-shot-'))
      const tempPath = join(tempDir, `screenshot.${EXTENSION[first.mediaType] ?? 'png'}`)
      await writeFile(tempPath, first.data)
      // The clipboard write holds the screen lock: another session's paste (Ctrl+V plus its
      // restore) could otherwise land between this write and the user's paste. The
      // observation and the file write stay outside the lock — they touch no shared state.
      try {
        await withScreenLock(exec.agent?.id, () => backend.copyImageToClipboard(
          { path: tempPath, mediaType: first.mediaType },
          exec.signal,
        ))
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      }
      return {
        paths: [...paths],
        clipboard: true,
        ...observedFields(session, { screens: [...observation.screens], foreground }),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'long_press',
    description:
      'Two-step press-and-hold with two-stage aiming. Without confirm it moves the pointer and returns a zoomed '
      + 'crop (screen 1) of the target; call again with screen_index=1 and a position inside the crop to aim finer '
      + '(the second preview zooms to window height / 12). confirm=true presses and holds at the point the last '
      + 'preview settled on, then returns the post-action screenshot. duration_seconds defaults to 3 and must be 1–10.',
    parameters: {
      screen_index: { type: 'integer', required: true, description: '0 for the attached frontmost-window screenshot.' },
      position: {
        type: 'array',
        required: true,
        items: { type: 'number' },
        description: '[x, y] as a 0–1000 fraction of that screenshot, not pixels.',
      },
      duration_seconds: {
        type: 'number',
        default: 3,
        description: 'Hold duration in seconds. Default: 3. Must be 1–10.',
      },
      confirm: {
        type: 'boolean',
        default: false,
        description:
          'false (default) previews only: moves the pointer to the target and returns a zoomed crop without '
          + 'holding. Pass true to execute.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          screenIndex: { type: 'integer', required: true },
          position: { type: 'array', required: true, items: { type: 'number' } },
          durationSeconds: { type: 'number', required: true },
          confirmed: { type: 'boolean', required: true },
          zoomLevel: { type: 'number' },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD,
        },
      },
      render: (_args, value) => resultBlocks(
        value.confirmed === false
          ? previewText(value, 'long press')
          : `Long-pressed screen ${String(value.screenIndex)} at [${value.position.join(', ')}] for ${String(value.durationSeconds)}s. ${coordinatesRemain(value)}`,
        value.screens,
        value.foreground,
        value,
      ),
    },
    isConcurrencySafe: () => false,
    presentCall: args => genericExecute('Long press', {
      screen_index: args.screen_index,
      position: args.position,
      duration_seconds: args.duration_seconds ?? 3,
    }),
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec)
      const position = validatedPosition(exec, args.position)
      const durationSeconds = requireLongPressDuration(args.duration_seconds)
      const confirm = args.confirm === true
      return guiTurn(backend, exec, async () => {
        const gate = await runPointerAction(ctx, exec, backend, {
          screenIndex: args.screen_index,
          position: hidPosition(exec, position),
          confirm,
          tool: 'long_press',
        }, {
          screenIndex: args.screen_index,
          position,
          durationSeconds,
        })
        if (gate.done) return gate.result
        await backend.longPress({
          screen: pointScreenAt(gate.point, gate.windowScreen.windowId, 1),
          position: [0, 0],
          durationSeconds,
        }, exec.signal)
        const observation = await recapture(ctx, backend, exec, config.postActionWaitMs)
        return {
          screenIndex: args.screen_index,
          position,
          durationSeconds,
          confirmed: true,
          ...observedFields(sessionOf(exec), observation),
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'drag',
    description:
      'Two-step drag with two-stage aiming at the start point. Without confirm it moves the pointer to the start '
      + 'and returns a zoomed crop (screen 1); call again with start_screen_index=1 and a position inside the crop '
      + 'to aim finer (the second preview zooms to window height / 12). confirm=true drags from the point the last '
      + 'preview settled on to the given end position, then returns the post-action screenshot.',
    parameters: {
      start_screen_index: {
        type: 'integer',
        required: true,
        description: '0 for the attached frontmost-window screenshot.',
      },
      start_position: {
        type: 'array',
        required: true,
        items: { type: 'number' },
        description: '[x, y] start as a 0–1000 fraction of that screenshot, not pixels.',
      },
      end_screen_index: {
        type: 'integer',
        required: true,
        description: '0 for the attached frontmost-window screenshot.',
      },
      end_position: {
        type: 'array',
        required: true,
        items: { type: 'number' },
        description: '[x, y] end as a 0–1000 fraction of that screenshot, not pixels.',
      },
      confirm: {
        type: 'boolean',
        default: false,
        description:
          'false (default) previews only: moves the pointer to the start and returns a zoomed crop without '
          + 'dragging. Pass true to execute.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          startScreenIndex: { type: 'integer', required: true },
          startPosition: { type: 'array', required: true, items: { type: 'number' } },
          endScreenIndex: { type: 'integer', required: true },
          endPosition: { type: 'array', required: true, items: { type: 'number' } },
          confirmed: { type: 'boolean', required: true },
          zoomLevel: { type: 'number' },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD,
        },
      },
      render: (_args, value) => resultBlocks(
        value.confirmed === false
          ? previewText({ zoomLevel: value.zoomLevel }, 'drag')
          : `Dragged from screen ${String(value.startScreenIndex)} [${value.startPosition.join(', ')}] `
            + `to screen ${String(value.endScreenIndex)} [${value.endPosition.join(', ')}]. ${coordinatesRemain(value)}`,
        value.screens,
        value.foreground,
        value,
      ),
    },
    isConcurrencySafe: () => false,
    presentCall: args => genericExecute('Drag', {
      start_screen_index: args.start_screen_index,
      end_screen_index: args.end_screen_index,
    }),
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec)
      const startPosition = validatedPosition(exec, args.start_position)
      const endPosition = validatedPosition(exec, args.end_position)
      const confirm = args.confirm === true
      return guiTurn(backend, exec, async () => {
        const gate = await runPointerAction(ctx, exec, backend, {
          screenIndex: args.start_screen_index,
          position: hidPosition(exec, startPosition),
          confirm,
          tool: 'drag',
        }, {
          startScreenIndex: args.start_screen_index,
          startPosition,
          endScreenIndex: args.end_screen_index,
          endPosition,
        })
        if (gate.done) return gate.result
        const screens = await backend.listScreens(exec.signal)
        const endScreen = requireScreen(screens, args.end_screen_index)
        await backend.drag({
          startScreen: pointScreenAt(gate.point, gate.windowScreen.windowId, 1),
          startPosition: [0, 0],
          endScreen,
          endPosition: hidPosition(exec, endPosition),
        }, exec.signal)
        const observation = await recapture(ctx, backend, exec, config.postActionWaitMs)
        return {
          startScreenIndex: args.start_screen_index,
          startPosition,
          endScreenIndex: args.end_screen_index,
          endPosition,
          confirmed: true,
          ...observedFields(sessionOf(exec), observation),
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'open_in_browser',
    description:
      'Open the default browser, or a full http(s) URL in it, then return the post-action screenshot. '
      + 'This is the user-visible browser. Do not use web_fetch as a substitute. '
      + 'Chinese in path or query must be plain text, never CJK percent-encoding such as %E5... / %E8....',
    parameters: {
      url: {
        type: 'string',
        description: 'http(s) URL to open. Omit to launch the default browser with no page.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD,
        },
      },
      render: (_args, value) => resultBlocks(
        value.url === undefined
          ? `Opened the default browser. ${coordinatesRemain(value)}`
          : `Opened ${value.url} in the default browser. ${coordinatesRemain(value)}`,
        value.screens,
        value.foreground,
        value,
      ),
    },
    isConcurrencySafe: () => false,
    presentCall: args => genericExecute('Open in browser', args.url === undefined ? {} : { url: args.url }),
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec)
      const url = args.url === undefined || args.url.trim() === '' ? undefined : requireBrowserUrl(args.url)
      // The browser activation steals the foreground, so it holds the screen lock even though it
      // posts no HID and stays outside the overlay cloak.
      return withScreenLock(exec.agent?.id, async () => {
        await backend.openInBrowser(url === undefined ? {} : { url }, exec.signal)
        const observation = await recapture(ctx, backend, exec, config.postActionWaitMs)
        return {
          ...url === undefined ? {} : { url },
          ...observedFields(sessionOf(exec), observation),
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'open_in_finder',
    description:
      'Open a folder in Finder, open a file with its default app, or reveal a file in Finder, then return the post-action screenshot. '
      + 'Omit path to open the Desktop. Use reveal_only only to select a file in Finder (Open With or rename/move). '
      + 'Pass a real path; do not OCR one from the screenshot.',
    parameters: {
      path: {
        type: 'string',
        description: 'Absolute or ~ path. Omit to open the user Desktop.',
      },
      reveal_only: {
        type: 'boolean',
        default: false,
        description: 'When true and path is a file, reveal it in Finder instead of opening it. Default: false.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          revealOnly: { type: 'boolean', required: true },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD,
        },
      },
      render: (_args, value) => resultBlocks(
        value.revealOnly
          ? `Revealed ${value.path} in Finder. ${coordinatesRemain(value)}`
          : `Opened ${value.path}. ${coordinatesRemain(value)}`,
        value.screens,
        value.foreground,
        value,
      ),
    },
    isConcurrencySafe: () => false,
    presentCall: args => genericExecute('Open in Finder', {
      ...args.path === undefined ? {} : { path: args.path },
      reveal_only: args.reveal_only ?? false,
    }),
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec)
      const requestedReveal = args.reveal_only ?? false
      const target = await resolveFinderOpen(args.path, requestedReveal)
      const info = await stat(target.path)
      const revealOnly = target.revealOnly && info.isFile()
      // Finder activation steals the foreground, so it holds the screen lock even though it posts
      // no HID and stays outside the overlay cloak.
      return withScreenLock(exec.agent?.id, async () => {
        await backend.openInFinder({ path: target.path, revealOnly }, exec.signal)
        const observation = await recapture(ctx, backend, exec, config.postActionWaitMs)
        return {
          path: target.path,
          revealOnly,
          ...observedFields(sessionOf(exec), observation),
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_apps',
    description:
      'List running regular (Dock-visible) applications by display name, then return the current frontmost-window screenshot. '
      + 'Use this when the attached window is the wrong app.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          apps: { type: 'array', required: true, items: { type: 'string' } },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD,
        },
      },
      render: (_args, value) => resultBlocks(
        value.apps.length === 0
          ? `No running regular applications. ${coordinatesRemain(value)}`
          : `Running apps: ${value.apps.join(', ')}. ${coordinatesRemain(value)}`,
        value.screens,
        value.foreground,
        value,
      ),
    },
    isConcurrencySafe: () => false,
    presentCall: () => genericExecute('List apps', {}),
    async execute(_args, exec) {
      await assertImageCapableRoute(ctx, exec)
      const apps = await backend.listApps(exec.signal)
      const observation = await recapture(ctx, backend, exec)
      return {
        apps: [...apps],
        ...observedFields(sessionOf(exec), observation),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'open_app',
    description:
      'Activate a running application or launch it by display name or bundle id, then return the post-action screenshot. '
      + 'Use this when the attached window is the wrong app. Do not click the Dock.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Localized application name or bundle identifier, for example Pages or com.apple.TextEdit.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          action: { type: 'string', enum: ['activated', 'launched'] },
          error: { type: 'string' },
          ...COORDINATE_FIELDS,
          screens: SCREENS_FIELD,
          foreground: FOREGROUND_FIELD,
        },
      },
      render: (_args, value) => resultBlocks(
        value.ok
          ? `Opened ${value.name} (${value.action ?? 'activated'}). ${coordinatesRemain(value)}`
          : `Could not open ${value.name}: ${value.error ?? 'unknown error'}. ${coordinatesRemain(value)}`,
        value.screens,
        value.foreground,
        value,
      ),
    },
    isConcurrencySafe: () => false,
    presentCall: args => genericExecute('Open app', { name: args.name }),
    async execute(args, exec) {
      await assertImageCapableRoute(ctx, exec)
      const name = args.name.trim()
      if (name === '') throw new Error('name must be a non-empty application name or bundle id')
      return guiTurn(backend, exec, async () => {
        let action: 'activated' | 'launched' | undefined
        let error: string | undefined
        let settleMs = 0
        try {
          const result = await backend.openApp({ name }, exec.signal)
          action = result.kind
          settleMs = config.postActionWaitMs
        } catch (caught: unknown) {
          if (exec.signal.aborted || (caught instanceof Error && caught.name === 'AbortError')) throw caught
          error = caught instanceof Error ? caught.message : String(caught)
        }
        const observation = await recapture(ctx, backend, exec, settleMs)
        return {
          name,
          ok: error === undefined,
          ...action === undefined ? {} : { action },
          ...error === undefined ? {} : { error },
          ...observedFields(sessionOf(exec), observation),
        }
      })
    },
  }))

  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || decision.messages.length === 0) return decision
    if (isDesktopSelectionTurn(messages)) return decision
    if (!messages.some(message => message.source.kind === 'user')) return decision
    if (!await routeAcceptsImages(ctx, agent, signal)) return decision
    signal.throwIfAborted()
    const mode = coordinateModeOf(agent.session)
    const observation = await observeDesktop(ctx, backend, signal, { coordinateMode: mode })
    rememberObservation(agent.session, observation.screens)
    signal.throwIfAborted()
    const notice = createUserMessage({
      content: [
        {
          type: 'text',
          text: firstFrameNotice(mode),
        },
        ...observation.blocks,
      ],
      source: {
        kind: 'computer-use',
        form: 'notice',
        summary: 'Frontmost window attached',
      },
    })
    return { ...decision, messages: [...decision.messages, notice] }
  })
}
