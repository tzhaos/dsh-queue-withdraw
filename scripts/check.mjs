/**
 * Zero-dependency verification for dsh-queue-withdraw.
 *
 * Run with `node scripts/check.mjs`. The suite exercises the plugin's injected
 * actions and the real DOM decoration component through a miniature React
 * runtime and a DOM-shaped fake.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { apply as applyHostPlugin } from '../index.js'

// Keep the Host-side frozen-id file inside a scratch directory.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-queue-withdraw-check-'))

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
  assert.equal(manifest.version, '1.11.5')
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

await check('client only requires the frozen React modules', () => {
  const allowed = new Set(['react', 'react-dom'])
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
  assert(css.includes('[data-dshq-row]'), 'row drag affordance styles')
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
    useState(initial) {
      const index = cursor
      cursor += 1
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      return [hooks[index], (next) => {
        hooks[index] = typeof next === 'function' ? next(hooks[index]) : next
      }]
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
    this.style = {}
    this._rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }
  }

  getBoundingClientRect() {
    const { left, top, width, height } = this._rect
    return { left, top, width, height, right: left + width, bottom: top + height }
  }

  cloneNode() {
    const copy = new FakeNode(this.tagName.toLowerCase())
    copy.className = this.className
    copy._rect = { ...this._rect }
    for (const child of this.children) copy.append(child.cloneNode())
    return copy
  }

  get nextSibling() {
    if (this.parentElement === null) return null
    const index = this.parentElement.children.indexOf(this)
    return this.parentElement.children[index + 1] ?? null
  }

  append(child) {
    child.parentElement = this
    this.children.push(child)
    return child
  }

  appendChild(child) { return this.append(child) }

  get firstChild() { return this.children[0] ?? null }

  get firstElementChild() { return this.children[0] ?? null }

  get lastElementChild() { return this.children[this.children.length - 1] ?? null }

  get classList() {
    const node = this
    return {
      contains(name) { return node.className.split(/\s+/).filter(Boolean).includes(name) },
      add(name) {
        const set = new Set(node.className.split(/\s+/).filter(Boolean))
        set.add(name)
        node.className = [...set].join(' ')
      },
      remove(name) {
        const set = new Set(node.className.split(/\s+/).filter(Boolean))
        set.delete(name)
        node.className = [...set].join(' ')
      },
      toggle(name, force) {
        const set = new Set(node.className.split(/\s+/).filter(Boolean))
        const add = force === undefined ? !set.has(name) : force
        if (add) set.add(name)
        else set.delete(name)
        node.className = [...set].join(' ')
      },
    }
  }

  insertBefore(child, anchor) {
    if (child.parentElement !== null) {
      child.parentElement.children = child.parentElement.children.filter((node) => node !== child)
    }
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
    if (selector === '[data-conversation-session]' || selector === '[data-queue-dock]') {
      let node = this
      while (node !== null) {
        if (node.getAttribute?.(selector) !== null) return node
        node = node.parentElement
      }
      return null
    }
    if (selector === 'li') {
      let node = this
      while (node !== null) {
        if (node.tagName === 'LI') return node
        node = node.parentElement
      }
      return null
    }
    if (selector === 'button, a, input, textarea, select, label, [contenteditable="true"], [role="button"]') {
      let node = this
      while (node !== null) {
        if (node.tagName === 'BUTTON' || node.tagName === 'A' || node.tagName === 'INPUT'
          || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT' || node.tagName === 'LABEL'
          || node.getAttribute?.('contenteditable') === 'true' || node.getAttribute?.('role') === 'button') return node
        node = node.parentElement
      }
      return null
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
    if (selector === '[data-dshq-withdraw]') {
      return descendants.find((node) => node.getAttribute('data-dshq-withdraw') !== null) ?? null
    }
    if (selector === '[data-dshq-freeze]') {
      return descendants.find((node) => node.getAttribute('data-dshq-freeze') !== null) ?? null
    }
    if (selector === 'ul, ol') {
      return descendants.find((node) => node.tagName === 'UL' || node.tagName === 'OL') ?? null
    }
    if (selector === 'li') return descendants.find((node) => node.tagName === 'LI') ?? null
    if (selector === '[class*="preview"]') {
      return descendants.find((node) => typeof node.className === 'string' && node.className.includes('preview')) ?? null
    }
    if (selector === '[class*="actions"]') {
      return descendants.find((node) => typeof node.className === 'string' && node.className.includes('actions')) ?? null
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
  dock.className = 'v1kfCW_dock'
  dock.setAttribute('data-queue-dock', '')
  owner.append(dock)
  const panel = new FakeNode('div')
  panel.className = 'v1kfCW_panel'
  dock.append(panel)
  const list = new FakeNode('ul')
  list.className = 'v1kfCW_list'
  panel.append(list)
  const rows = []
  const actionBoxes = []
  for (let index = 0; index < rowCount; index += 1) {
    const row = new FakeNode('li')
    row.className = 'v1kfCW_row'
    list.append(row)
    const preview = new FakeNode('span')
    preview.className = 'v1kfCW_preview'
    row.append(preview)
    const actionBox = new FakeNode('div')
    actionBox.className = 'v1kfCW_actions'
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
    _panel: panel,
    _list: list,
    _row: rows[0],
    _rows: rows,
    _actions: actionBoxes[0],
    _actionBoxes: actionBoxes,
    _hit: null,
    _listeners: new Map(),
    createElement: (tag) => new FakeNode(tag),
    elementFromPoint: () => document._hit,
    addEventListener(type, callback) {
      if (!document._listeners.has(type)) document._listeners.set(type, [])
      document._listeners.get(type).push(callback)
    },
    removeEventListener(type, callback) {
      document._listeners.set(type, (document._listeners.get(type) ?? []).filter((entry) => entry !== callback))
    },
    async dispatch(type, event = {}) {
      event.preventDefault ??= () => {}
      event.stopPropagation ??= () => {}
      for (const callback of document._listeners.get(type) ?? []) await callback(event)
    },
    querySelectorAll: (selector) => selector === '[data-queue-dock]' ? (dock.isConnected ? [dock] : [])
      : selector === '[data-dshq-row]' ? rows.filter((row) => row.getAttribute('data-dshq-row') !== null)
        : selector === '[data-dshq-withdraw]' ? rows.flatMap((row) => row.descendants()).filter((node) => node.getAttribute('data-dshq-withdraw') !== null)
          : selector === '[data-dshq-freeze]' ? rows.flatMap((row) => row.descendants()).filter((node) => node.getAttribute('data-dshq-freeze') !== null)
            : [],
  }
  void queueText
  return document
}

/** Load the client module against a fake runtime/document. */
function loadClient({ react, document, sessions, locale, fetch }) {
  let loaded
  const storage = new Map()
  const sandbox = {
    window: {
      __ModuleLoader__: { load(definition) { loaded = definition } },
      localStorage: {
        getItem: (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => { storage.set(key, value) },
      },
    },
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
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  }
  if (fetch !== undefined) sandbox.fetch = fetch
  vm.runInNewContext(clientSource, sandbox, { filename: 'client.js' })
  return {
    plugin: loaded.factory((id) => {
      if (id === 'react') return react
      if (id === 'react-dom') return { createPortal: (node) => node }
      throw new Error('unexpected require ' + id)
    }),
    storage,
  }
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
  const attachmentIds = [...(options.attachmentIds ?? [])]
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
    snapshot: {
      get draft() { return draft.value },
      get attachmentIds() { return attachmentIds },
    },
  }
  const updateQueueCalls = []
  const conversation = {
    input: { for: () => notification },
    createDrafts: (sessionId, files) => {
      draftCalls.push({ sessionId, files })
      return files.map((file, index) => ({ kind: 'image', id: 'draft-' + (index + 1), file, previewUrl: 'blob:draft' }))
    },
    updateQueue: async (itemId, action) => {
      updateQueueCalls.push({ itemId, action })
      return { ok: true }
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
  const loaded = loadClient({ react: reactRuntime.react, document, sessions, fetch: options.fetch })
  const plugin = loaded.plugin
  const storage = loaded.storage
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
    updates, notices, draft, attachmentIds, session, scope, notification, t, injected, conversation,
    addedAttachments, removedAttachments, releasedDrafts, draftCalls, readCalls, storage, updateQueueCalls,
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
  const tree = reactRuntime.render(registration.component, props)
  return { snapshot, tree }
}
// ---------------------------------------------------------------------------
// 3. Behaviour
// ---------------------------------------------------------------------------

await check('locked rows use a strikethrough and a per-row lock instead of a blue outline', () => {
  assert(clientSource.includes('dshqw-locked-row'))
  assert(clientSource.includes('text-decoration: line-through'))
  assert(clientSource.includes('LOCK_ICON'))
  assert(clientSource.includes('UNLOCK_ICON'))
  assert(clientSource.includes('readFrozen'))
  assert(!clientSource.includes('dshqw-frozen-item'), 'no synthetic rows')
  assert(!clientSource.includes('box-shadow: inset 0 0 0 1px color-mix'), 'no outline indicator')
  assert(clientSource.includes('li [class*="lead"]'), 'the redundant Host queue icon is hidden')
})

await check('layout churn diagnostics are wired', () => {
  assert(clientSource.includes("reportLayout('dock-geometry'"))
  assert(clientSource.includes("reportLayout('buttons-dropped'"))
  assert(clientSource.includes('noteDecoration('))
  assert(clientSource.includes('data-submission-echo'))
})

await check('injected actions match the Host action geometry', () => {
  assert(clientSource.includes('width: 28px;'), '28px hit box')
  assert(clientSource.includes('height: 28px;'), '28px hit box height')
  assert(clientSource.includes('border-radius: 999px'), 'circle hit box')
  assert(!clientSource.includes('width: 20px'), 'no shrunken lock button')
  assert(!clientSource.includes('viewBox="0 0 16 16" width="14"'), 'glyphs fill the 14px box')
  assert(clientSource.includes('row.insertBefore(freeze, actions)'), 'lock precedes the native actions')
  assert(clientSource.includes('row.append?.(withdraw)'), 'withdraw trails the native actions')
})

await check('a locked message disables editing and unlocking returns it to the queue', async () => {
  let ids = ['item-1']
  const applied = scenario({
    fetch: async (url) => {
      if (url.includes('/frozen')) return { ok: true, json: async () => ({ ok: true, ids: [...ids] }) }
      if (url.includes('/thaw')) {
        ids = ids.filter((id) => id !== 'item-1')
        return { ok: true, json: async () => ({ ok: true }) }
      }
      return { ok: true, json: async () => ({ ok: true }) }
    },
  })
  const hostEdit = applied.document._actions.children.find((node) => node.getAttribute('aria-label') === '编辑')
  mountDecoration(applied, [queueItem('queued text')])
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(hostEdit.disabled, true, 'Host edit disabled while locked')
  assert.equal(applied.document._rows[0].classList.contains('dshqw-locked-row'), true)
  const lock = applied.document._rows[0].descendants().find((node) => node.getAttribute('data-dshq-freeze') !== null)
  assert(lock, 'per-row lock button rendered')
  assert.equal(lock.getAttribute('data-locked'), 'true')
  await lock.dispatch('click')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(hostEdit.disabled, false, 'edit restored after unlock')
  assert.equal(applied.document._rows[0].classList.contains('dshqw-locked-row'), false)
  assert.equal(lock.getAttribute('data-locked'), 'false')
})

await check('an empty conversation renders no overlay tree', () => {
  const applied = scenario()
  const { tree } = mountDecoration(applied, [])
  assert.equal(tree, null)
})

await check('factory registers one queue-dock decoration', () => {
  const { plugin, registrations, registration, localeRegistrations } = scenario()
  equal(plugin.inject.slice().sort(), ['locale', 'sessions', 'slots'])
  assert.equal(registrations.length, 1)
  assert.equal(registration.options.name, 'conversation.input.dock')
  assert.equal(registration.options.id, 'queue-withdraw')
  assert.equal(registration.options.order, 21)
  assert.equal(localeRegistrations[0].ns, 'queueWithdraw')
})

await check('freeze posts the id to the Host route', async () => {
  const requests = []
  const applied = scenario({
    fetch: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) })
      return { ok: true, json: async () => ({ ok: true, index: 1 }) }
    },
  })
  const ok = await applied.injected.actions.freeze('item-1', 'failed')
  assert.equal(ok, true)
  assert.equal(requests[0].url, '/dsh-queue-withdraw/freeze')
  equal(requests[0].body, { sessionId: 'session-a', itemId: 'item-1' })
  equal(applied.notices, [], 'successful freeze is silent')
})

await check('readFrozen returns the Host ids', async () => {
  const applied = scenario({
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, ids: ['item-1', 'item-2'] }) }),
  })
  const ids = await applied.injected.actions.readFrozen('failed')
  equal(ids, ['item-1', 'item-2'])
})

await check('freeze keeps the queue untouched when the Host rejects it', async () => {
  const applied = scenario({
    fetch: async () => ({ ok: false, json: async () => ({ ok: false, reason: 'queue-changed' }) }),
  })
  const ok = await applied.injected.actions.freeze('item-1', 'failed')
  assert.equal(ok, false)
  assert.equal(applied.storage.has('dsh.queueWithdraw.frozen'), false)
  equal(applied.notices, [{ level: 'error', text: 'failed' }])
})

await check('withdraw appends text to the draft and removes the queue item', async () => {
  const applied = scenario({ draft: 'existing' })
  const item = queueItem('queued text')
  const ok = await applied.injected.actions.withdraw(item, 'empty', 'failed', 'attachment')
  assert.equal(ok, true)
  assert.equal(applied.draft.value, 'queued text')
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
  assert.equal(applied.draft.value, 'queued text')
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

await check('text messages keep the Host native inline editor', () => {
  const applied = scenario({ draft: 'existing' })
  const hostEdit = applied.document._actions.children.find((node) => node.getAttribute('aria-label') === '编辑')
  mountDecoration(applied, [queueItem('queued text')])
  assert.equal(hostEdit.disabled, false)
  assert.equal(hostEdit.getAttribute('aria-label'), '编辑', 'the Host label is untouched')
  assert.equal(hostEdit.getAttribute('data-dshq-edit'), null, 'no interception marker')
})

await check('native text edits keep the message attachments', async () => {
  const applied = scenario()
  const image = { type: 'image', attachment: { attachmentId: 'image-1', mediaType: 'image/png' } }
  mountDecoration(applied, [queueItem('queued text', [image])])
  await applied.conversation.updateQueue('item-1', { kind: 'edit', content: [{ type: 'text', text: 'edited' }] })
  equal(applied.updateQueueCalls[0].action.content, [{ type: 'text', text: 'edited' }, image])
})

await check('attachment-only messages fall back to the plugin editor', () => {
  const applied = scenario({ draft: 'existing' })
  const item = { id: 'item-1', content: [{ type: 'image', attachment: { attachmentId: 'image-1', mediaType: 'image/png' } }] }
  const hostEdit = applied.document._actions.children.find((node) => node.getAttribute('aria-label') === '编辑')
  hostEdit.disabled = true
  mountDecoration(applied, [item])
  assert.equal(hostEdit.disabled, false, 'the Host control is re-enabled for the fallback')
  assert.equal(hostEdit.getAttribute('aria-label'), '编辑排队消息')
})

await check('unsupported queue content leaves the Host edit control disabled', () => {
  const applied = scenario()
  const item = queueItem('queued text', [{ type: 'audio', attachment: { attachmentId: 'audio-1' } }])
  const hostEdit = applied.document._actions.children.find((node) => node.getAttribute('aria-label') === '编辑')
  hostEdit.disabled = true
  mountDecoration(applied, [item])
  assert.equal(hostEdit.disabled, true)
})

await check('a separate withdraw control is injected into the Host row', () => {
  assert(clientSource.includes("data-dshq-withdraw"))
  assert(clientSource.includes('withdrawThrough(withdraw'))
})

await check('rows are draggable without a drag handle icon', () => {
  assert(clientSource.includes('dshqw-drag-ghost'))
  assert(clientSource.includes('dshqw-drag-source'))
  assert(clientSource.includes("row.addEventListener('pointerdown'"))
  assert(!clientSource.includes('data-dshq-handle'), 'no handle button')
  assert(!clientSource.includes('dshqw-handle'), 'no handle styles')
  assert(clientSource.includes('onRowControl'), 'row controls keep their own presses')
})

await check('drag-to-merge uses the Host update route instead of a global button', () => {
  assert(clientSource.includes('dshqw-merge-target'))
  assert(clientSource.includes('mergeInto'))
  assert(clientSource.includes('/dsh-queue-withdraw/update'))
  assert(!clientSource.includes('mergeQueue'))
})

await check('dragging the row body posts the complete new order', async () => {
  const requests = []
  const fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  const applied = scenario({ rows: 2, fetch })
  const second = { ...queueItem('second'), id: 'item-2' }
  mountDecoration(applied, [queueItem('first'), second])
  const [first, last] = applied.document._rows
  first._rect = { left: 0, top: 0, width: 400, height: 36 }
  last._rect = { left: 0, top: 36, width: 400, height: 36 }
  assert.equal(last.getAttribute('data-dshq-row'), '', 'the row is the drag source')
  assert.equal(last.getAttribute('data-dshq-handle'), null, 'no handle injected')
  await last.dispatch('pointerdown', { button: 0, clientX: 200, clientY: 54, target: last })
  applied.document._hit = first
  await applied.document.dispatch('pointermove', { clientX: 200, clientY: 10 })
  await applied.document.dispatch('pointerup', {})
  const reorder = requests.filter((request) => request.url.endsWith('/reorder'))
  equal(reorder.map((request) => request.url), ['/dsh-queue-withdraw/reorder'])
  equal(reorder[0].body, { sessionId: 'session-a', order: ['item-2', 'item-1'] })
})

await check('composer attachments are restored after the session component unmounts', async () => {
  const applied = scenario()
  const file = { name: 'notes.txt', size: 10, type: 'text/plain', lastModified: 1 }
  const drafts = applied.conversation.createDrafts('session-a', [file])
  applied.attachmentIds.push(drafts[0].id)
  applied.injected.actions.saveDraftAttachments()
  applied.attachmentIds.length = 0
  await applied.injected.actions.restoreDraftAttachments()
  assert.deepEqual(applied.addedAttachments, ['draft-1'])
})

// ---------------------------------------------------------------------------
// 4. Host reorder route
// ---------------------------------------------------------------------------

function hostScenario() {
  let route
  let updateRoute
  let freezeRoute
  let thawRoute
  let frozenRoute
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
        const path = String(definition.path)
        if (path.endsWith('/update')) updateRoute = definition
        else if (path.endsWith('/freeze')) freezeRoute = definition
        else if (path.endsWith('/thaw')) thawRoute = definition
        else if (path.endsWith('/frozen')) frozenRoute = definition
        else if (path.endsWith('/reorder')) route = definition
        return () => {}
      },
    },
    agents: { get: (sessionId) => typeof sessionId === 'string' && sessionId.startsWith('session-') ? agent : undefined },
    attachments: {
      async saveImages(inputs) { return inputs.map((_input, index) => ({ attachmentId: 'image-new-' + String(index), mediaType: 'image/png', name: 'new.png' })) },
      async saveFile(input) { return { attachmentId: 'file-new', name: input.name ?? 'new.bin', bytes: input.data.length } },
    },
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
  const invokeUpdate = async (body) => {
    const response = { status: null, headers: null, payload: null }
    const req = { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }
    const res = { writeHead(status) { response.status = status }, end(text) { response.payload = JSON.parse(text) } }
    await updateRoute.handler(req, res)
    return { response, messages }
  }
  const invokeOn = async (definition, body) => {
    const response = { status: null, headers: null, payload: null }
    const req = { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }
    const res = { writeHead(status) { response.status = status }, end(text) { response.payload = JSON.parse(text) } }
    await definition.handler(req, res)
    return { response, messages }
  }
  return { route, updateRoute, freezeRoute, thawRoute, frozenRoute, invoke, invokeUpdate, invokeOn, messages }
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

await check('the Host update route merges target plus dragged content with attachments', async () => {
  const host = hostScenario()
  host.messages[0].content.push({ type: 'image', attachment: { attachmentId: 'image-1', mediaType: 'image/png' } })
  const { response, messages } = await host.invokeUpdate({ sessionId: 'session-a', action: 'merge', targetId: 'item-1', sourceId: 'item-2' })
  assert.equal(response.status, 200)
  equal(messages.map((message) => message.id), ['item-1'])
  equal(messages[0].content, [
    { type: 'text', text: 'first' },
    { type: 'image', attachment: { attachmentId: 'image-1', mediaType: 'image/png' } },
    { type: 'text', text: 'second' },
  ])
})

await check('the Host update route replaces text and keeps existing attachments', async () => {
  const host = hostScenario()
  const image = { type: 'image', attachment: { attachmentId: 'image-1', mediaType: 'image/png' } }
  host.messages[0].content.push(image)
  const { response, messages } = await host.invokeUpdate({
    sessionId: 'session-a',
    action: 'edit',
    itemId: 'item-1',
    text: 'edited',
    blocks: [image],
    files: [],
  })
  assert.equal(response.status, 200)
  equal(messages[0].content, [{ type: 'text', text: 'edited' }, image])
})

await check('the Host freeze route keeps the message queued and reports its slot', async () => {
  const host = hostScenario()
  assert.equal(host.freezeRoute.path, '/dsh-queue-withdraw/freeze')
  const { response, messages } = await host.invokeOn(host.freezeRoute, { sessionId: 'session-freeze', itemId: 'item-1' })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.equal(response.payload.index, 0)
  equal(messages.map((message) => message.id), ['item-1', 'item-2'], 'the message stays in next-turn')
  const frozen = await host.invokeOn(host.frozenRoute, { sessionId: 'session-freeze' })
  equal(frozen.response.payload.ids, ['item-1'])
})

await check('the Host freeze route rejects an item that is not queued', async () => {
  const host = hostScenario()
  const { response } = await host.invokeOn(host.freezeRoute, { sessionId: 'session-missing', itemId: 'missing' })
  assert.equal(response.status, 409)
  equal(host.messages.map((message) => message.id), ['item-1', 'item-2'])
})

await check('the Host thaw route releases a held id', async () => {
  const host = hostScenario()
  assert.equal(host.thawRoute.path, '/dsh-queue-withdraw/thaw')
  await host.invokeOn(host.freezeRoute, { sessionId: 'session-thaw', itemId: 'item-1' })
  const { response } = await host.invokeOn(host.thawRoute, { sessionId: 'session-thaw', itemId: 'item-1' })
  assert.equal(response.status, 200)
  const frozen = await host.invokeOn(host.frozenRoute, { sessionId: 'session-thaw' })
  equal(frozen.response.payload.ids, [])
  equal(host.messages.map((entry) => entry.id), ['item-1', 'item-2'])
})

await check('the Host frozen route reports only that session ids', async () => {
  const host = hostScenario()
  await host.invokeOn(host.freezeRoute, { sessionId: 'session-list', itemId: 'item-2' })
  const frozen = await host.invokeOn(host.frozenRoute, { sessionId: 'session-list' })
  equal(frozen.response.payload.ids, ['item-2'])
  const other = await host.invokeOn(host.frozenRoute, { sessionId: 'session-other' })
  equal(other.response.payload.ids, [])
})

await check('the Host claim patch skips held ids at the turn boundary', async () => {
  class FakeInbox {
    constructor(sessionId, messages) {
      this.sessionId = sessionId
      this.messages = messages
      this.events = []
    }
    get session() { return { id: this.sessionId } }
    get nextTurn() { return this.messages }
    get nextStep() { return [] }
    get dispatch() { return { emit: (name, payload) => this.events.push({ name, payload }) } }
    mutate(target, start, deleteCount, inserted) {
      if (target !== 'next-turn') return []
      return this.messages.splice(start, deleteCount, ...inserted)
    }
    claim(target) {
      const claimed = this.mutate('next-step', 0, 0, [], false)
      if (target === 'next-turn') claimed.push(...this.mutate('next-turn', 0, 1, [], false))
      return claimed
    }
  }
  const inbox = new FakeInbox('session-claim', [
    { id: 'held', content: [{ type: 'text', text: 'held' }] },
    { id: 'free', content: [{ type: 'text', text: 'free' }] },
  ])
  const routes = {}
  const ctx = {
    effect: (factory) => factory(),
    webServer: { register: (definition) => { routes[definition.path] = definition; return () => {} } },
    agents: { get: (sessionId) => sessionId === 'session-claim' ? { inbox } : undefined },
    sessions: { list: { getSnapshot: () => ({ ids: ['session-claim'] }) } },
    attachments: {},
  }
  applyHostPlugin(ctx)
  const invoke = async (path, body) => {
    const response = { status: null, payload: null }
    const req = { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }
    const res = { writeHead(status) { response.status = status }, end(text) { response.payload = JSON.parse(text) } }
    await routes[path].handler(req, res)
    return response
  }
  // Boot arming patched the prototype through the session list.
  await invoke('/dsh-queue-withdraw/freeze', { sessionId: 'session-claim', itemId: 'held' })
  const first = inbox.claim('next-turn', { id: 'turn-1' })
  equal(first.map((message) => message.id), ['free'], 'the held id is skipped')
  const second = inbox.claim('next-turn', { id: 'turn-2' })
  equal(second, [], 'nothing is claimed while the rest is held')
  equal(inbox.nextTurn.map((message) => message.id), ['held'])
  await invoke('/dsh-queue-withdraw/thaw', { sessionId: 'session-claim', itemId: 'held' })
  const third = inbox.claim('next-turn', { id: 'turn-3' })
  equal(third.map((message) => message.id), ['held'], 'thawed ids are claimed again')
})

if (process.exitCode === 1) {
  console.error('\n' + checks + ' check(s) passed, some failed')
} else {
  console.log('\nall checks passed (' + checks + ')')
}


