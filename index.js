/**
 * Host half of the queue-withdraw bundle.
 *
 * The browser half owns queue-row decoration and the composer draft. Reordering
 * pending messages needs the Host's Inbox splice, so this half exposes one
 * narrow same-origin route: it accepts the complete next-turn id order and
 * applies it atomically after verifying the ids still match the live queue.
 *
 * @module dsh-queue-withdraw
 */

const REORDER_PATH = '/dsh-queue-withdraw/reorder'
const UPDATE_PATH = '/dsh-queue-withdraw/update'
const MAX_BODY = 32 * 1024 * 1024

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
}

export const inject = ['webServer', 'agents', 'attachments']
