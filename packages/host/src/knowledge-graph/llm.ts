/**
 * Reuse the plugin's existing model route for the two small graph calls: the one-line
 * search difference and the execution verdict. No new provider, key, or endpoint is
 * introduced; a Host without `llm` simply leaves both features on their fallbacks.
 */

import type { GraphCompletion } from './search.ts'

/** The small slice of dsh-llm this module calls, declared structurally. */
interface HostLlm {
  prepareCall(
    config: { provider: string; model: string; reasoningEffort?: string },
    signal?: AbortSignal,
  ): Promise<{
    readonly config: Record<string, unknown>
    readonly inputModalities?: readonly string[]
    stream(options: Record<string, unknown>): AsyncIterable<{ type?: string; text?: string }>
  }>
}

/** The selection source the Host already exposes. */
export interface GraphModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** The official attachment store, declared structurally. */
export interface GraphAttachmentStore {
  saveImage(input: {
    readonly data: Uint8Array
    readonly mediaType: string
    readonly name?: string
  }): Promise<{
    readonly attachmentId: string
    readonly mediaType?: string
    readonly bytes?: number
    readonly width?: number
    readonly height?: number
    readonly name?: string
  }>
}

/** The minimal host context needed to resolve a model. */
export interface GraphLlmHost {
  get(name: string): unknown
  readonly agentDefaultModel?: {
    currentSelection(): GraphModelSelection
  }
  /** Optional image channel; absent keeps the judge text-only. */
  readonly attachments?: GraphAttachmentStore
}

/**
 * Build the one-shot completion the graph service uses.
 * @param ctx - plugin context; `llm` is read live so a late-mounted service still works.
 * @param fallback - selection to use when the agent default is unavailable.
 * @returns a completion, or undefined when this Host has no `llm` service.
 */
export function graphCompletionFrom(
  ctx: GraphLlmHost,
  fallback: () => GraphModelSelection | undefined,
): GraphCompletion | undefined {
  const llm = ctx.get('llm') as HostLlm | undefined
  if (llm === undefined || llm === null || typeof llm.prepareCall !== 'function') return undefined
  return async (prompt, signal, images) => {
    const selection = resolveSelection(ctx, fallback)
    if (selection === undefined) throw new Error('no model selection available')
    const prepared = await llm.prepareCall({
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    }, signal)
    const content: Record<string, unknown>[] = [{ type: 'text', text: prompt }]
    // A node screenshot is only useful to a route that accepts images. Saving it
    // through the Host's attachment service also gives the adapter its durable ref.
    const acceptsImages = prepared.inputModalities?.includes('image') === true
    if (acceptsImages && images !== undefined && images.length > 0 && ctx.attachments !== undefined) {
      for (const image of images.slice(0, 4)) {
        try {
          const attachment = await ctx.attachments.saveImage({
            data: image.data,
            mediaType: image.mediaType,
            ...image.name === undefined ? {} : { name: image.name },
          })
          content.push({
            type: 'image',
            attachment: {
              attachmentId: attachment.attachmentId,
              mediaType: attachment.mediaType ?? image.mediaType,
              bytes: attachment.bytes ?? image.data.length,
              width: attachment.width ?? 0,
              height: attachment.height ?? 0,
              ...attachment.name === undefined && image.name === undefined ? {} : { name: attachment.name ?? image.name },
            },
          })
        } catch {
          // One unreadable screenshot must not discard the text verdict.
        }
      }
    }
    let text = ''
    const stream = prepared.stream({
      ...prepared.config,
      messages: [{ role: 'user', content }],
      ...signal === undefined ? {} : { signal },
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    }
    if (text.trim() === '') throw new Error('empty model answer')
    return text
  }
}

function resolveSelection(ctx: GraphLlmHost, fallback: () => GraphModelSelection | undefined): GraphModelSelection | undefined {
  try {
    const current = ctx.agentDefaultModel?.currentSelection()
    if (current !== undefined && current.provider !== '' && current.model !== '') return current
  } catch {
    // Fall through to the profile's background route.
  }
  try {
    return fallback()
  } catch {
    return undefined
  }
}
