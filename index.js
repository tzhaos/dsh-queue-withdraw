/**
 * Host half of the queue-withdraw bundle.
 *
 * The browser half owns queue-row decoration and the composer draft. Reordering
 * pending messages needs the Host's Inbox splice, so this half exposes one
 * narrow same-origin route: it accepts the complete next-turn id order and
 * applies it atomically after verifying the ids still match the live queue.
 *
 * Freezing keeps a message inside `next-turn` (so every queue control still
 * works on it) and only stops the turn boundary from claiming it. The held ids
 * live in this Host half, are persisted under `$DSH_HOME`, and are enforced by
 * wrapping the inbox `claim` entry point.
 *
 * @module dsh-queue-withdraw
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REORDER_PATH = '/dsh-queue-withdraw/reorder'
const UPDATE_PATH = '/dsh-queue-withdraw/update'
const FREEZE_PATH = '/dsh-queue-withdraw/freeze'
const THAW_PATH = '/dsh-queue-withdraw/thaw'
const FROZEN_PATH = '/dsh-queue-withdraw/frozen'
const DIAG_PATH = '/dsh-queue-withdraw/diag'
const MAX_BODY = 32 * 1024 * 1024

/** Per-session ids the loop must not claim; mirrored to `$DSH_HOME`. */
const frozenSessions = new Map()

/** @returns {string} the layout-diagnostic log path. */
function diagFile() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'queue-withdraw-diag.jsonl')
}

/** @returns {string} the persistent frozen-id file. */
function frozenFile() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'queue-withdraw-frozen.json')
}

/** Load the persisted frozen ids once per Host process. */
function loadFrozen() {
  try {
    const raw = fs.readFileSync(frozenFile(), 'utf8')
    const parsed = JSON.parse(raw)
    const sessions = parsed !== null && typeof parsed === 'object' ? parsed.sessions : undefined
    if (sessions === null || typeof sessions !== 'object') return
    for (const [sessionId, ids] of Object.entries(sessions)) {
      if (!Array.isArray(ids)) continue
      frozenSessions.set(sessionId, new Set(ids.filter((id) => typeof id === 'string')))
    }
  } catch {
    // A missing or unreadable file simply starts with nothing frozen.
  }
}

/** Persist the current frozen ids. */
function saveFrozen() {
  const sessions = {}
  for (const [sessionId, ids] of frozenSessions) {
    if (ids.size > 0) sessions[sessionId] = [...ids]
  }
  try {
    fs.mkdirSync(path.dirname(frozenFile()), { recursive: true })
    fs.writeFileSync(frozenFile(), JSON.stringify({ version: 1, sessions }, null, 2) + '\n', 'utf8')
  } catch {
    // The in-memory set still enforces this process lifetime.
  }
}

/**
 * @param {string} sessionId - conversation id.
 * @returns {Set<string>} held message ids.
 */
function frozenIdsOf(sessionId) {
  let ids = frozenSessions.get(sessionId)
  if (ids === undefined) {
    ids = new Set()
    frozenSessions.set(sessionId, ids)
  }
  return ids
}

/**
 * Wrap the inbox claim entry so held ids are skipped instead of sent. The patch
 * sits on the shared prototype, so it covers every agent created afterwards.
 * @param {object} inbox - one agent's durable inbox.
 */
function installClaimPatch(inbox) {
  if (inbox === null || inbox === undefined || typeof inbox !== 'object') return
  const proto = Object.getPrototypeOf(inbox)
  if (proto === null || typeof proto.claim !== 'function') return
  if (proto.__dshQueueWithdrawClaimPatched === true) return
  const original = proto.claim
  proto.claim = function patchedClaim(target, turn) {
    if (target !== 'next-turn') return original.call(this, target, turn)
    const held = frozenIdsOf(this.session?.id)
    if (held.size === 0) return original.call(this, target, turn)
    const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
    const queue = this.nextTurn
    const index = queue.findIndex((message) => !held.has(String(message.id)))
    if (index >= 0) claimed.push(...this.mutate('next-turn', index, 1, [], false))
    for (const message of claimed) this.dispatch.emit('agent/inbox/claimed', { message, turn })
    return claimed
  }
  Object.defineProperty(proto, '__dshQueueWithdrawClaimPatched', { value: true, enumerable: false })
}

/**
 * Patch every agent the Host can currently reach.
 * @param {object} ctx - Host context.
 */
function armAgents(ctx) {
  try {
    const state = ctx.sessions?.list?.getSnapshot?.()
    const ids = Array.isArray(state?.ids) ? state.ids : Object.keys(state?.byId ?? {})
    for (const sessionId of ids) {
      const agent = ctx.agents?.get?.(sessionId)
      if (agent?.inbox !== undefined) installClaimPatch(agent.inbox)
    }
  } catch {
    // The claim patch is also installed by every freeze/thaw/arm request.
  }
}

/**
 * @param {object} res - Node response.
 * @param {number} status - HTTP status.
 * @param {object} body - JSON payload.
 */
function sendJson(res, status, body) {
  res.writeHead?.(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end?.(JSON.stringify(body))
}

/**
 * Read and parse the JSON request body.
 * @param {object} req - Node request.
 * @returns {Promise<object|null>} parsed body, or null when invalid.
 */
async function readJson(req) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY) return null
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Keep only attachment blocks this plugin understands.
 * @param {unknown} value - client-supplied blocks.
 * @returns {object[]} safe image/file blocks.
 */
function attachmentBlocks(value) {
  if (!Array.isArray(value)) return []
  const blocks = []
  for (const block of value) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'image' && block.type !== 'file') continue
    if (block.attachment === null || typeof block.attachment !== 'object') continue
    blocks.push({ type: block.type, attachment: block.attachment })
  }
  return blocks
}

/**
 * Persist one browser-uploaded attachment and return its queue block.
 * @param {object} attachments - Host attachment store.
 * @param {object} file - name, mediaType, kind and canonical base64 data.
 * @returns {Promise<object>} image/file content block.
 */
async function saveUpload(attachments, file) {
  if (typeof file?.data !== 'string' || file.data === '') throw new Error('empty upload')
  const bytes = Uint8Array.from(Buffer.from(file.data, 'base64'))
  if (file.kind === 'image') {
    const refs = await attachments.saveImages([{
      data: bytes,
      mediaType: typeof file.mediaType === 'string' ? file.mediaType : 'image/png',
      ...(typeof file.name === 'string' && file.name !== '' ? { name: file.name } : {}),
    }])
    return { type: 'image', attachment: refs[0] }
  }
  const ref = await attachments.saveFile({
    data: bytes,
    ...(typeof file.name === 'string' && file.name !== '' ? { name: file.name } : {}),
  })
  return { type: 'file', attachment: ref }
}

/**
 * Register the reorder and content-edit routes.
 * @param {object} ctx - Host context.
 */
export function apply(ctx) {
  if (ctx?.webServer?.register === undefined || ctx?.agents?.get === undefined) return
  loadFrozen()
  armAgents(ctx)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: REORDER_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, reason: 'method-not-allowed' })
        return
      }
      const body = await readJson(req)
      if (body === null || typeof body !== 'object') {
        sendJson(res, 400, { ok: false, reason: 'invalid-body' })
        return
      }
      const sessionId = body.sessionId
      const order = body.order
      if (typeof sessionId !== 'string' || sessionId === ''
        || !Array.isArray(order) || order.some((id) => typeof id !== 'string')) {
        sendJson(res, 400, { ok: false, reason: 'invalid-request' })
        return
      }
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined || agent?.inbox === undefined) {
        sendJson(res, 409, { ok: false, reason: 'agent-unavailable' })
        return
      }
      const current = [...agent.inbox.nextTurn]
      if (order.length !== current.length || new Set(order).size !== order.length) {
        sendJson(res, 409, { ok: false, reason: 'queue-changed' })
        return
      }
      const byId = new Map(current.map((message) => [String(message.id), message]))
      if (order.some((id) => !byId.has(id))) {
        sendJson(res, 409, { ok: false, reason: 'queue-changed' })
        return
      }
      const reordered = order.map((id) => byId.get(id))
      try {
        agent.inbox.splice('next-turn', 0, current.length, reordered)
        sendJson(res, 200, { ok: true })
      } catch {
        sendJson(res, 500, { ok: false, reason: 'reorder-failed' })
      }
    },
  }), 'queue-withdraw: reorder route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: UPDATE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, reason: 'method-not-allowed' })
        return
      }
      const body = await readJson(req)
      if (body === null || typeof body !== 'object') {
        sendJson(res, 400, { ok: false, reason: 'invalid-body' })
        return
      }
      const sessionId = body.sessionId
      const action = body.action
      if (typeof sessionId !== 'string' || (action !== 'edit' && action !== 'merge')) {
        sendJson(res, 400, { ok: false, reason: 'invalid-request' })
        return
      }
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined || agent?.inbox === undefined) {
        sendJson(res, 409, { ok: false, reason: 'agent-unavailable' })
        return
      }
      const current = [...agent.inbox.nextTurn]
      if (action === 'merge') {
        const targetId = String(body.targetId ?? '')
        const sourceId = String(body.sourceId ?? '')
        const target = current.find((message) => String(message.id) === targetId)
        const source = current.find((message) => String(message.id) === sourceId)
        if (target === undefined || source === undefined || targetId === sourceId) {
          sendJson(res, 409, { ok: false, reason: 'queue-changed' })
          return
        }
        const merged = { ...target, content: [...target.content, ...source.content] }
        const next = current.flatMap((message) => {
          if (String(message.id) === sourceId) return []
          if (String(message.id) === targetId) return [merged]
          return [message]
        })
        try {
          agent.inbox.splice('next-turn', 0, current.length, next)
          sendJson(res, 200, { ok: true })
        } catch {
          sendJson(res, 500, { ok: false, reason: 'merge-failed' })
        }
        return
      }
      const itemId = String(body.itemId ?? '')
      const target = current.find((message) => String(message.id) === itemId)
      if (target === undefined) {
        sendJson(res, 409, { ok: false, reason: 'queue-changed' })
        return
      }
      if (ctx.attachments === undefined) {
        sendJson(res, 500, { ok: false, reason: 'attachments-unavailable' })
        return
      }
      try {
        const blocks = attachmentBlocks(body.blocks)
        const files = Array.isArray(body.files) ? body.files : []
        for (const file of files) blocks.push(await saveUpload(ctx.attachments, file))
        const text = typeof body.text === 'string' ? body.text : ''
        const content = [
          ...(text.trim() === '' ? [] : [{ type: 'text', text }]),
          ...blocks,
        ]
        if (content.length === 0) {
          sendJson(res, 400, { ok: false, reason: 'empty-content' })
          return
        }
        const edited = { ...target, content }
        const next = current.map((message) => String(message.id) === itemId ? edited : message)
        agent.inbox.splice('next-turn', 0, current.length, next)
        sendJson(res, 200, { ok: true })
      } catch {
        sendJson(res, 500, { ok: false, reason: 'edit-failed' })
      }
    },
  }), 'queue-withdraw: update route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: FREEZE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, reason: 'method-not-allowed' })
        return
      }
      const body = await readJson(req)
      if (body === null || typeof body !== 'object') {
        sendJson(res, 400, { ok: false, reason: 'invalid-body' })
        return
      }
      const sessionId = body.sessionId
      const itemId = body.itemId
      if (typeof sessionId !== 'string' || sessionId === ''
        || typeof itemId !== 'string' || itemId === '') {
        sendJson(res, 400, { ok: false, reason: 'invalid-request' })
        return
      }
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined || agent?.inbox === undefined) {
        sendJson(res, 409, { ok: false, reason: 'agent-unavailable' })
        return
      }
      installClaimPatch(agent.inbox)
      const current = [...agent.inbox.nextTurn]
      const index = current.findIndex((message) => String(message.id) === itemId)
      if (index < 0) {
        sendJson(res, 409, { ok: false, reason: 'queue-changed' })
        return
      }
      // The message stays queued so every native control still works; only the
      // turn boundary is told to skip it.
      frozenIdsOf(sessionId).add(itemId)
      saveFrozen()
      sendJson(res, 200, { ok: true, index })
    },
  }), 'queue-withdraw: freeze route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: THAW_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, reason: 'method-not-allowed' })
        return
      }
      const body = await readJson(req)
      if (body === null || typeof body !== 'object') {
        sendJson(res, 400, { ok: false, reason: 'invalid-body' })
        return
      }
      const sessionId = body.sessionId
      const itemId = String(body.itemId ?? '')
      if (typeof sessionId !== 'string' || sessionId === '' || itemId === '') {
        sendJson(res, 400, { ok: false, reason: 'invalid-request' })
        return
      }
      frozenIdsOf(sessionId).delete(itemId)
      saveFrozen()
      sendJson(res, 200, { ok: true })
    },
  }), 'queue-withdraw: thaw route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: FROZEN_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, reason: 'method-not-allowed' })
        return
      }
      const body = await readJson(req)
      const sessionId = body !== null && typeof body === 'object' ? body.sessionId : undefined
      if (typeof sessionId !== 'string' || sessionId === '') {
        sendJson(res, 400, { ok: false, reason: 'invalid-request' })
        return
      }
      const agent = ctx.agents.get(sessionId)
      if (agent?.inbox !== undefined) installClaimPatch(agent.inbox)
      sendJson(res, 200, { ok: true, ids: [...frozenIdsOf(sessionId)] })
    },
  }), 'queue-withdraw: frozen route')

  // Temporary layout probe: the client reports the geometry whenever visible
  // space appears between the queue dock and the composer.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DIAG_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, reason: 'method-not-allowed' })
        return
      }
      const body = await readJson(req)
      if (body === null || typeof body !== 'object') {
        sendJson(res, 400, { ok: false, reason: 'invalid-body' })
        return
      }
      try {
        fs.mkdirSync(path.dirname(diagFile()), { recursive: true })
        fs.appendFileSync(diagFile(), JSON.stringify({ at: new Date().toISOString(), ...body }) + '\n', 'utf8')
      } catch {
        // A failed diagnostic write never affects the conversation.
      }
      sendJson(res, 200, { ok: true })
    },
  }), 'queue-withdraw: layout diagnostic route')
}

export const inject = ['webServer', 'agents', 'sessions', 'attachments']
