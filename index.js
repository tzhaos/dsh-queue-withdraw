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
const MAX_BODY = 32 * 1024

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
 * Register the reorder route.
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
}

export const inject = ['webServer', 'agents']
