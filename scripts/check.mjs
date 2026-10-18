/**
 * Zero-dependency verification for dsh-queue-withdraw.
 *
 * Run with `node scripts/check.mjs`. The suite exercises the plugin's injected
 * actions and the real DOM decoration component through a miniature React
 * runtime and a DOM-shaped fake.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { apply as applyHostPlugin } from '../index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const manifest = JSON.parse(read('package.json'))
const clientSource = read('client.js')

let checks = 0

/** Run one named check. */
async function check(name, body) {
  try {
    await body()
    checks += 1
    console.log('ok ' + name)
  } catch (error) {
    console.error('FAIL ' + name)
    console.error('     ' + (error?.message ?? error))
    process.exitCode = 1
  }
}

/** Compare JSON-shaped values out of the vm realm. */
function equal(actual, expected, message) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message)
}

// ---------------------------------------------------------------------------
// 1. Static contract
// ---------------------------------------------------------------------------

await check('manifest declares a DSH bundle and web client half', () => {
  assert.equal(manifest.name, 'dsh-queue-withdraw')
  assert.equal(manifest.version, '1.4.0')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.main, 'index.js')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'), 'conversation inject')
  assert(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-api-session-controller'), 'session inject')
  assert.equal(manifest.scripts.check, 'node scripts/check.mjs')
})

await check('all manifest files exist on disk', () => {
  for (const relative of [
    manifest.main, 'client.js', manifest.dsh.bundle.patch,
    'locale/en.json', 'locale/zh.json', 'icon.svg', 'README.md', 'README.en.md',
    'CHANGELOG.md', 'LICENSE',
  ]) assert(fs.existsSync(path.join(ROOT, relative)), relative + ' exists')
})

await check('bundle patch inserts exactly one queue-withdraw row', () => {
  const patch = read('cordis.patch.yml')
  assert(patch.includes('- insert:'), 'insert block')
  assert(patch.includes('id: queue-withdraw'), 'row id')
  assert(patch.includes("name: 'dsh-queue-withdraw'"), 'package name')
  assert.equal((patch.match(/- insert:/g) ?? []).length, 1, 'one insert')
})

await check('client only requires the frozen React module', () => {
  const allowed = new Set(['react'])
  const requires = [...clientSource.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1])
  for (const id of requires) assert(allowed.has(id), 'unexpected require ' + id)
  assert(requires.includes('react'), 'react required')
})

await check('stylesheet uses theme tokens and no literal colors', () => {
  const start = clientSource.indexOf('const CSS = `')
  const end = clientSource.indexOf('\n`', start)
  assert(start !== -1 && end !== -1, 'stylesheet found')
  const css = clientSource.slice(start, end)
  assert.deepEqual([...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0]), [], 'literal colors')
  assert(css.includes('var(--dsw-'), 'theme tokens present')
  assert(css.includes('.dshqw-handle'), 'drag handle styles')
})

await check('locale files carry title and description', () => {
  for (const language of ['en', 'zh']) {
    const meta = JSON.parse(read('locale/' + language + '.json')).meta
    assert.equal(typeof meta.title, 'string', language + ' title')
    assert.equal(typeof meta.description, 'string', language + ' description')
    assert(meta.title.length > 0 && meta.description.length > 0, language + ' non-empty')
  }
})

await check('icon is a valid accent SVG', () => {
  const icon = read('icon.svg')
  assert(icon.startsWith('<svg'), 'svg root')
  assert(icon.includes('viewBox="0 0 64 64"'), 'view box')
  assert(icon.includes('#4D6BFE'), 'host accent')
})

// ---------------------------------------------------------------------------
// 2. Fake runtime, DOM and fixture
// ---------------------------------------------------------------------------

/** A small React runtime with the hooks the decoration uses. */
function createFakeReact() {
  const hooks = []
  const depsEqual = (left, right) => Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  let cursor = 0
  let queuedEffects = []

  const react = {
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) }
      const flat = []
      const push = (child) => {
        if (child === null || child === undefined || typeof child === 'boolean') return
        if (Array.isArray(child)) { for (const value of child) push(value); return }
        flat.push(child)
      }
      for (const child of children) push(child)
      if (flat.length === 1) merged.children = flat[0]
      else if (flat.length > 1) merged.children = flat
      return { type, props: merged }
    },
    useMemo(factory) {
      const index = cursor
      cursor += 1
      if (!(index in hooks)) hooks[index] = factory()
      return hooks[index]
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      if (!(index in hooks)) hooks[index] = { current: initial }
      return hooks[index]
    },
    useEffect(effect, deps) {
      const index = cursor
      cursor += 1
      const previous = hooks[index]
      if (previous !== undefined && previous !== null && deps !== undefined && depsEqual(previous.deps, deps)) return
      hooks[index] = { deps }
      queuedEffects.push(effect)
    },
  }

  return {
    react,
    begin() { cursor = 0; queuedEffects = [] },
    end() {
      const effects = queuedEffects
      queuedEffects = []
      for (const effect of effects) effect()
      return effects.length
    },
    render(component, props) {
      react.createElement(component, props)
      this.begin()
      const result = component(props)
      this.end()
      return result
    },
  }
}

/** Fake DOM node with just the selector surface used by the plugin. */
class FakeNode {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase()
    this.children = []
    this.parentElement = null
    this.attributes = new Map()
    this.dataset = {}
    this.className = ''
    this.disabled = false
    this.title = ''
    this.innerHTML = ''
    this.textContent = ''
    this.isConnected = true
    this.listeners = new Map()
  }

  append(child) {
    child.parentElement = this
    this.children.push(child)
    return child
  }

  appendChild(child) { return this.append(child) }

  get firstChild() { return this.children[0] ?? null }

  insertBefore(child, anchor) {
    child.parentElement = this
    const index = anchor === null ? this.children.length : this.children.indexOf(anchor)
    if (index < 0) this.children.push(child)
    else this.children.splice(index, 0, child)
    return child
  }

  remove() {
    this.isConnected = false
    if (this.parentElement === null) return
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this)
    this.parentElement = null
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  hasAttribute(name) { return this.attributes.has(name) }

  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(callback)
  }

  async dispatch(type, event = {}) {
    event.preventDefault ??= () => {}
    event.stopPropagation ??= () => {}
    for (const callback of this.listeners.get(type) ?? []) await callback(event)
  }

  descendants() {
    const all = []
    for (const child of this.children) {
      all.push(child)
      all.push(...child.descendants())
    }
    return all
  }

  closest(selector) {
    if (selector !== '[data-conversation-session]') return null
    if (this.getAttribute('data-conversation-session') !== null) return this
    let node = this.parentElement
    while (node !== null) {
      if (node.getAttribute?.(selector) !== null) return node
      node = node.parentElement
    }
    return null
  }

  contains(node) {
    if (node === this) return true
    return this.descendants().includes(node)
  }

  querySelectorAll(selector) {
    const descendants = this.descendants()
    if (selector === 'li') return descendants.filter((node) => node.tagName === 'LI')
    if (selector === 'button[aria-label]') {
      return descendants.filter((node) => node.tagName === 'BUTTON' && node.getAttribute('aria-label') !== null)
    }
    return []
  }

  querySelector(selector) {
    const descendants = this.descendants()
    if (selector === '[data-dsh-queue-withdraw]') {
      return descendants.find((node) => node.getAttribute('data-dsh-queue-withdraw') !== null) ?? null
    }
    if (selector === '[data-dshq-handle]') {
      return descendants.find((node) => node.getAttribute('data-dshq-handle') !== null) ?? null
    }
    return null
  }
}

/** Fake document with one QueueDock row, an owner Session wrapper and a body. */
function createFakeDocument(queueText, rowCount = 1) {
  const body = new FakeNode('body')
  const owner = new FakeNode('div')
  owner.setAttribute('data-conversation-session', 'session-a')
  body.append(owner)
  const dock = new FakeNode('div')
  dock.setAttribute('data-queue-dock', '')
  owner.append(dock)
  const rows = []
  const actionBoxes = []
  for (let index = 0; index < rowCount; index += 1) {
    const row = new FakeNode('li')
    dock.append(row)
    const actionBox = new FakeNode('div')
    row.append(actionBox)
    const hostEdit = new FakeNode('button')
    hostEdit.setAttribute('aria-label', '编辑')
    actionBox.append(hostEdit)
    rows.push(row)
    actionBoxes.push(actionBox)
  }
  const document = {
    body,
    head: { appendChild() {} },
    _dock: dock,
    _row: rows[0],
    _rows: rows,
    _actions: actionBoxes[0],
    _actionBoxes: actionBoxes,
    createElement: (tag) => new FakeNode(tag),
    querySelectorAll: (selector) => selector === '[data-queue-dock]' ? [dock]
      : selector === '[data-dshq-handle]' ? rows.flatMap((row) => row.descendants()).filter((node) => node.getAttribute('data-dshq-handle') !== null)
        : [],
  }
  void queueText
  return document
}

/** Load the client module against a fake runtime/document. */
function loadClient({ react, document, sessions, locale, fetch }) {
  let loaded
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { loaded = definition } } },
    document,
    File: class FakeFile {
      constructor(parts, name, options) {
        this.parts = parts
        this.name = name
        this.type = options?.type ?? ''
      }
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    console,
  }
  if (fetch !== undefined) sandbox.fetch = fetch
  vm.runInNewContext(clientSource, sandbox, { filename: 'client.js' })
  return loaded.factory((id) => {
    if (id === 'react') return react
    throw new Error('unexpected require ' + id)
  })
}

/** Translator for one locale dictionary. */
function translator(dictionary) {
  return (key, params = {}) => {
    const template = dictionary[key] ?? key
    return template.replace(/\{(\w+)\}/g, (_match, name) => String(params[name] ?? '{' + name + '}'))
  }
}

/** Build one applied plugin and its inject face. */
function scenario(options = {}) {
  const updates = []
  const notices = []
  const draft = { value: options.draft ?? '' }
  const addedAttachments = []
  const removedAttachments = []
  const releasedDrafts = []
  const draftCalls = []
  const readCalls = []
  const session = {
    updateQueue: async (itemId, action) => {
      updates.push({ itemId, action })
      return options.updateResult ?? { ok: true }
    },
    readAttachment: async (attachmentId) => {
      readCalls.push(attachmentId)
      return {
        ok: true,
        value: {
          attachment: { mediaType: 'image/png', name: 'withdrawn.png' },
          data: new Uint8Array([1, 2, 3]),
        },
      }
    },
  }
  const notification = {
    notify: (level, text) => { notices.push({ level, text }) },
    actions: {
      setDraft: (text) => { draft.value = text },
      addAttachments: (ids) => { addedAttachments.push(...ids); return true },
      removeAttachment: (id) => { removedAttachments.push(id) },
    },
    snapshot: { get draft() { return draft.value } },
  }
  const conversation = {
    input: { for: () => notification },
    createDrafts: (sessionId, files) => {
      draftCalls.push({ sessionId, files })
      return files.map((file, index) => ({ kind: 'image', id: 'draft-' + (index + 1), file, previewUrl: 'blob:draft' }))
    },
    releaseDraftAttachment: (id) => { releasedDrafts.push(id) },
  }
  const scope = { get: (name) => name === 'conversation' ? conversation : undefined }
  const sessions = {
    scope: () => scope,
    binding: () => ({ session }),
  }
  const document = createFakeDocument(options.queueText ?? 'queued text', options.rows ?? 1)
  const localeRegistrations = []
  const registrations = []
  const reactRuntime = createFakeReact()
  const plugin = loadClient({ react: reactRuntime.react, document, sessions, fetch: options.fetch })
  const ctx = {
    effect: (factory) => { factory(); return () => {} },
    sessions,
    locale: { register: (ns, dicts) => { localeRegistrations.push({ ns, dicts }); return () => {} } },
    slots: {
      inject: (_slot, callback) => callback(),
      register: (entryOptions, component) => {
        registrations.push({ options: entryOptions, component })
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  const registration = registrations[0]
  const t = translator(localeRegistrations[0].dicts.zh)
  const injected = registration.options.inject('session-a')
  return {
    plugin, registration, registrations, localeRegistrations, document, reactRuntime,
    updates, notices, draft, session, scope, notification, t, injected, conversation,
    addedAttachments, removedAttachments, releasedDrafts, draftCalls, readCalls,
  }
}

/** One queue item. */
function queueItem(text, extra = []) {
  return {
    id: 'item-1',
    content: [{ type: 'text', text }, ...extra],
    source: { kind: 'user' },
  }
}

/** A standard idle session snapshot. */
function idleSnapshot() {
  return { subagent: null }
}

/** Mount the decoration component against one queue. */
function mountDecoration(applied, queue) {
  const { registration, reactRuntime, t, injected } = applied
  const snapshot = idleSnapshot()
  const props = {
    sessionId: 'session-a',
    useSession: (selector) => selector(snapshot),
    useProjection: (key) => key === 'inbox' ? { 'next-turn': queue } : undefined,
    actions: injected.actions,
    t,
  }
  reactRuntime.render(registration.component, props)
  return { snapshot }
}

// ---------------------------------------------------------------------------
// 3. Behaviour
// ---------------------------------------------------------------------------

await check('factory registers one queue-dock decoration', () => {
  const { plugin, registrations, registration, localeRegistrations } = scenario()
  equal(plugin.inject.slice().sort(), ['locale', 'sessions', 'slots'])
  assert.equal(registrations.length, 1)
  assert.equal(registration.options.name, 'conversation.input.dock')
  assert.equal(registration.options.id, 'queue-withdraw')
  assert.equal(registration.options.order, 21)
  assert.equal(localeRegistrations[0].ns, 'queueWithdraw')
})

await check('withdraw appends text to the draft and removes the queue item', async () => {
  const applied = scenario({ draft: 'existing' })
  const item = queueItem('queued text')
  const ok = await applied.injected.actions.withdraw(item, 'empty', 'failed', 'attachment')
  assert.equal(ok, true)
  assert.equal(applied.draft.value, 'existing\n\nqueued text')
  equal(applied.updates, [{ itemId: 'item-1', action: { kind: 'remove' } }])
  equal(applied.notices, [], 'successful withdraw is silent')
})

await check('withdraw restores the draft when the Host rejects removal', async () => {
  const applied = scenario({ draft: 'existing', updateResult: { ok: false } })
  const ok = await applied.injected.actions.withdraw(queueItem('queued text'), 'empty', 'failed', 'attachment')
  assert.equal(ok, false)
  assert.equal(applied.draft.value, 'existing')
  equal(applied.notices, [{ level: 'error', text: 'failed' }])
})

await check('a file attachment without a cache fails without touching the draft', async () => {
  const applied = scenario({ draft: 'existing' })
  const item = queueItem('queued text', [{ type: 'file', attachment: { attachmentId: 'file-1', name: 'notes.txt', bytes: 10 } }])
  const ok = await applied.injected.actions.withdraw(item, 'empty', 'failed', 'attachment', 'cache-missing')
  assert.equal(ok, false)
  assert.equal(applied.draft.value, 'existing')
  equal(applied.updates, [])
  equal(applied.notices, [{ level: 'error', text: 'cache-missing' }])
})

await check('withdraw rehydrates image attachments into the draft', async () => {
  const applied = scenario({ draft: 'existing' })
  const item = queueItem('', [{ type: 'image', attachment: { attachmentId: 'image-1', mediaType: 'image/png' } }])
  const ok = await applied.injected.actions.withdraw(item, 'empty', 'failed', 'attachment')
  assert.equal(ok, true)
  equal(applied.readCalls, ['image-1'])
  equal(applied.addedAttachments, ['draft-1'])
  assert.equal(applied.draftCalls.length, 1, 'draft file registered')
  equal(applied.updates, [{ itemId: 'item-1', action: { kind: 'remove' } }])
  equal(applied.notices, [], 'successful withdraw is silent')
})

await check('withdraw restores a file attachment from the temporary cache', async () => {
  const applied = scenario({ draft: 'existing' })
  const file = { name: 'notes.txt', size: 10, type: 'text/plain', lastModified: 1 }
  applied.conversation.createDrafts('session-a', [file])
  const item = queueItem('queued text', [{ type: 'file', attachment: { attachmentId: 'file-1', name: 'notes.txt', bytes: 10 } }])
  const ok = await applied.injected.actions.withdraw(item, 'empty', 'failed', 'attachment', 'cache-missing')
  assert.equal(ok, true)
  equal(applied.updates, [{ itemId: 'item-1', action: { kind: 'remove' } }])
  assert.equal(applied.draft.value, 'existing\n\nqueued text')
  equal(applied.notices, [], 'successful withdraw is silent')
  assert.equal(applied.draftCalls.length, 2, 'restored file registered')
  equal(applied.addedAttachments, ['draft-1'])
})

await check('forgetCached drops files after their queue message leaves', async () => {
  const applied = scenario({ draft: 'existing' })
  applied.conversation.createDrafts('session-a', [{ name: 'notes.txt', size: 10, type: 'text/plain' }])
  applied.injected.actions.forgetCached([{ name: 'notes.txt', size: 10 }])
  await new Promise((resolve) => setTimeout(resolve, 0))
  const item = queueItem('queued text', [{ type: 'file', attachment: { attachmentId: 'file-1', name: 'notes.txt', bytes: 10 } }])
  const ok = await applied.injected.actions.withdraw(item, 'empty', 'failed', 'attachment', 'cache-missing')
  assert.equal(ok, false)
  equal(applied.notices, [{ level: 'error', text: 'cache-missing' }])
})

await check('the Host edit control withdraws text instead of inline editing', async () => {
  const applied = scenario({ draft: 'existing' })
  const hostEdit = applied.document._actions.children.find((node) => node.getAttribute('aria-label') === '编辑')
  mountDecoration(applied, [queueItem('queued text')])
  assert.equal(hostEdit.disabled, false)
  assert.equal(hostEdit.title, '编辑并撤回到输入栏')
  await hostEdit.dispatch('click')
  assert.equal(applied.draft.value, 'existing\n\nqueued text')
  equal(applied.updates, [{ itemId: 'item-1', action: { kind: 'remove' } }])
})

await check('the Host edit control is enabled and withdraws attachment queues', async () => {
  const applied = scenario({ draft: 'existing' })
  const item = queueItem('queued text', [{ type: 'image', attachment: { attachmentId: 'image-1', mediaType: 'image/png' } }])
  const hostEdit = applied.document._actions.children.find((node) => node.getAttribute('aria-label') === '编辑')
  hostEdit.disabled = true
  mountDecoration(applied, [item])
  assert.equal(hostEdit.disabled, false, 'edit control enabled for attachments')
  assert.equal(hostEdit.title, '编辑并撤回到输入栏')
  await hostEdit.dispatch('click')
  assert.equal(applied.draft.value, 'existing\n\nqueued text')
  equal(applied.updates, [{ itemId: 'item-1', action: { kind: 'remove' } }])
})

await check('unsupported queue content leaves the Host edit control disabled', () => {
  const applied = scenario()
  const item = queueItem('queued text', [{ type: 'audio', attachment: { attachmentId: 'audio-1' } }])
  const hostEdit = applied.document._actions.children.find((node) => node.getAttribute('aria-label') === '编辑')
  hostEdit.disabled = true
  mountDecoration(applied, [item])
  assert.equal(hostEdit.disabled, true)
})

await check('no separate withdraw button is injected into the Host row', () => {
  const applied = scenario()
  mountDecoration(applied, [queueItem('queued text')])
  assert.equal(applied.document._row.querySelector('[data-dsh-queue-withdraw]'), null)
})

await check('dragging a queue row posts the complete new order', async () => {
  const requests = []
  const fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  const applied = scenario({ rows: 2, fetch })
  const second = { ...queueItem('second'), id: 'item-2' }
  mountDecoration(applied, [queueItem('first'), second])
  const handles = applied.document._rows.map((row) => row.querySelector('[data-dshq-handle]'))
  assert(handles[0] && handles[1], 'each row has a drag handle')
  assert.equal(applied.document._rows[0].children[0], handles[0], 'handle stays on the leading edge')
  const data = {
    types: ['application/x-dshq-item'],
    data: {},
    effectAllowed: '',
    dropEffect: '',
    getData(type) { return this.data[type] ?? '' },
    setData(type, value) { this.data[type] = value },
  }
  await handles[1].dispatch('dragstart', { dataTransfer: data })
  await applied.document._rows[0].dispatch('drop', { dataTransfer: data })
  equal(requests.map((request) => request.url), ['/dsh-queue-withdraw/reorder'])
  equal(requests[0].body, { sessionId: 'session-a', order: ['item-2', 'item-1'] })
})

// ---------------------------------------------------------------------------
// 4. Host reorder route
// ---------------------------------------------------------------------------

function hostScenario() {
  let route
  const messages = [
    { id: 'item-1', content: [{ type: 'text', text: 'first' }] },
    { id: 'item-2', content: [{ type: 'text', text: 'second' }] },
  ]
  const inbox = {
    get nextTurn() { return messages },
    splice(target, start, deleteCount, inserted) {
      if (target !== 'next-turn') throw new Error('wrong target')
      return messages.splice(start, deleteCount, ...inserted)
    },
  }
  const agent = { inbox }
  const ctx = {
    effect(factory) { factory(); return () => {} },
    webServer: {
      register(definition) {
        route = definition
        return () => {}
      },
    },
    agents: { get: (sessionId) => sessionId === 'session-a' ? agent : undefined },
  }
  applyHostPlugin(ctx)
  const invoke = async (body, method = 'POST') => {
    const response = { status: null, headers: null, payload: null }
    const req = {
      method,
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
    }
    const res = {
      writeHead(status, headers) { response.status = status; response.headers = headers },
      end(text) { response.payload = JSON.parse(text) },
    }
    await route.handler(req, res)
    return { response, messages }
  }
  return { route, invoke, messages }
}

await check('the Host route applies a complete next-turn order through inbox.splice', async () => {
  const host = hostScenario()
  assert.equal(host.route.path, '/dsh-queue-withdraw/reorder')
  const { response, messages } = await host.invoke({ sessionId: 'session-a', order: ['item-2', 'item-1'] })
  assert.equal(response.status, 200)
  equal(response.payload, { ok: true })
  equal(messages.map((message) => message.id), ['item-2', 'item-1'])
})

await check('the Host route rejects an order that no longer matches the queue', async () => {
  const host = hostScenario()
  const { response, messages } = await host.invoke({ sessionId: 'session-a', order: ['item-2'] })
  assert.equal(response.status, 409)
  equal(response.payload, { ok: false, reason: 'queue-changed' })
  equal(messages.map((message) => message.id), ['item-1', 'item-2'])
})

if (process.exitCode === 1) {
  console.error('\n' + checks + ' check(s) passed, some failed')
} else {
  console.log('\nall checks passed (' + checks + ')')
}
