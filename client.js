/**
 * Queue Withdraw — browser half of the `dsh-queue-withdraw` bundle.
 *
 * DSH's composer queue can edit, remove or steer a pending message. This plugin
 * adds the missing fourth verb: withdraw one queued message back into the
 * composer draft and remove it from the queue. The host QueueDock stays the
 * owner of the queue; the plugin only decorates each rendered row with one
 * compact action and submits the normal `updateQueue({ kind: 'remove' })`
 * request plus a draft write.
 *
 * @module dsh-queue-withdraw/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-queue-withdraw',
  factory(require) {
    const React = require('react')
    const { useEffect, useMemo, useRef } = React
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'queueWithdraw'

    const zh = {
      'button.label': '撤回到输入栏',
      'button.tooltip': '把这条排队消息撤回输入栏',
      'button.attachments': '这条消息包含暂不支持的附件内容',
      'button.cacheMissing': '没有找到该文件附件的本地缓存，无法撤回',
      'button.cacheHint': '撤回文件附件（使用本插件的本地缓存）',
      'button.editHint': '编辑包含附件的消息（会先撤回到输入栏）',
      'button.empty': '这条排队消息没有可撤回的文本',
      'button.failed': '撤回失败，消息仍在队列中',
    }

    const en = {
      'button.label': 'Withdraw to input',
      'button.tooltip': 'Withdraw this queued message back into the composer',
      'button.attachments': 'This message contains attachment content that cannot be withdrawn',
      'button.cacheMissing': 'No local cache was found for this file attachment; it cannot be withdrawn',
      'button.cacheHint': 'Withdraw file attachment (uses this plugin\'s local cache)',
      'button.editHint': 'Edit a message with attachments (withdraws it to the composer first)',
      'button.empty': 'This queued message has no text to withdraw',
      'button.failed': 'Withdraw failed; the message is still queued',
    }

    /** Icon used by the injected row action. */
    const WITHDRAW_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v7M5 6l3 3 3-3"/><path d="M3 12v1.5h10V12"/></svg>'

    /** Short-lived browser cache of files selected before a queue submission. */
    const CACHE_DB = 'dsh-queue-withdraw'
    const CACHE_STORE = 'files'
    const CACHE_TTL_MS = 24 * 60 * 60 * 1000
    const memoryCache = []
    let cacheDbPromise

    /** @returns {Promise<IDBDatabase|null>} cache database, or null when unavailable. */
    function openCacheDb() {
      if (typeof indexedDB === 'undefined') return Promise.resolve(null)
      if (cacheDbPromise !== undefined) return cacheDbPromise
      cacheDbPromise = new Promise((resolve) => {
        try {
          const request = indexedDB.open(CACHE_DB, 1)
          request.onupgradeneeded = () => {
            const db = request.result
            if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE, { keyPath: 'id' })
          }
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      })
      return cacheDbPromise
    }

    /** @param {File} file @param {string} sessionId @returns {object} cache record. */
    function cacheRecord(file, sessionId) {
      return {
        id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random(),
        sessionId,
        name: typeof file.name === 'string' ? file.name : '',
        size: typeof file.size === 'number' ? file.size : 0,
        type: typeof file.type === 'string' ? file.type : '',
        lastModified: typeof file.lastModified === 'number' ? file.lastModified : 0,
        file,
        cachedAt: Date.now(),
      }
    }

    /**
     * Remember selected files before the Host uploads them. Memory is written
     * synchronously; IndexedDB persistence is best-effort.
     * @param {string} sessionId - target conversation.
     * @param {File[]} files - browser-selected files.
     */
    function rememberFiles(sessionId, files) {
      if (!Array.isArray(files) || files.length === 0) return
      const cutoff = Date.now() - CACHE_TTL_MS
      for (let index = memoryCache.length - 1; index >= 0; index -= 1) {
        if (memoryCache[index].cachedAt < cutoff) memoryCache.splice(index, 1)
      }
      const records = files.map((file) => cacheRecord(file, sessionId))
      memoryCache.push(...records)
      void (async () => {
        const db = await openCacheDb()
        if (db === null) return
        try {
          const tx = db.transaction(CACHE_STORE, 'readwrite')
          const store = tx.objectStore(CACHE_STORE)
          const request = store.getAll()
          request.onsuccess = () => {
            for (const record of request.result ?? []) {
              if (record.cachedAt < cutoff) store.delete(record.id)
            }
          }
          for (const record of records) store.put(record)
        } catch {
          // The in-memory copy keeps this page functional.
        }
      })()
    }

    /**
     * Find the most recent cached file matching a queue attachment reference.
     * @param {string} sessionId - conversation id.
     * @param {string} name - original file name.
     * @param {number} size - file size.
     * @returns {Promise<object|null>} cache record.
     */
    async function findCachedFile(sessionId, name, size) {
      const match = (record) => record.sessionId === sessionId
        && record.name === name && record.size === size
      const memory = [...memoryCache].reverse().find(match)
      if (memory !== undefined) return memory
      const db = await openCacheDb()
      if (db === null) return null
      return await new Promise((resolve) => {
        try {
          const request = db.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).getAll()
          request.onsuccess = () => resolve((request.result ?? []).reverse().find(match) ?? null)
          request.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      })
    }

    /** @param {object[]} records - cached records to remove. */
    async function forgetCachedRecords(records) {
      for (const record of records) {
        const index = memoryCache.findIndex((candidate) => candidate.id === record.id)
        if (index >= 0) memoryCache.splice(index, 1)
      }
      const db = await openCacheDb()
      if (db === null) return
      try {
        const tx = db.transaction(CACHE_STORE, 'readwrite')
        for (const record of records) tx.objectStore(CACHE_STORE).delete(record.id)
      } catch {
        // TTL cleanup will collect an unremovable persistence copy.
      }
    }

    /**
     * Drop caches for file references that left the Host queue (sent or
     * removed). This implements the temporary-storage contract.
     * @param {string} sessionId - conversation id.
     * @param {Array<{name: string, size: number}>} refs - removed references.
     */
    async function forgetCachedRefs(sessionId, refs) {
      if (!Array.isArray(refs) || refs.length === 0) return
      const matches = memoryCache.filter((record) => record.sessionId === sessionId
        && refs.some((ref) => record.name === ref.name && record.size === ref.size))
      await forgetCachedRecords(matches)
      const db = await openCacheDb()
      if (db === null) return
      try {
        const request = db.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).getAll()
        request.onsuccess = () => {
          const persisted = (request.result ?? []).filter((record) => record.sessionId === sessionId
            && refs.some((ref) => record.name === ref.name && record.size === ref.size))
          void forgetCachedRecords(persisted)
        }
      } catch {
        // Best effort; stale records expire with the browser profile.
      }
    }

    /**
     * Wrap the conversation draft registry once so selected files are cached
     * before upload. This is the only point that has the browser File objects.
     * @param {object|undefined} conversation - conversation service.
     */
    function ensureDraftCacheHook(conversation) {
      if (conversation === null || conversation === undefined) return
      if (typeof conversation.createDrafts !== 'function') return
      if (conversation.__dshQueueWithdrawCache === true) return
      try {
        const original = conversation.createDrafts.bind(conversation)
        conversation.createDrafts = (sessionId, files) => {
          const drafts = original(sessionId, files)
          if (conversation.__dshQueueWithdrawRestoring !== true) rememberFiles(sessionId, files)
          return drafts
        }
        conversation.__dshQueueWithdrawCache = true
      } catch {
        // A frozen service cannot be decorated; file attachments stay uncached.
      }
    }

    /** @param {unknown} content @returns {Array<{type: string, ref: object}>} attachment blocks. */
    function attachmentBlocksOf(content) {
      if (!Array.isArray(content)) return []
      const blocks = []
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        if (block.type !== 'image' && block.type !== 'file') continue
        if (block.attachment !== null && typeof block.attachment === 'object') blocks.push({ type: block.type, ref: block.attachment })
      }
      return blocks
    }

    /**
     * Join the text blocks of one queue message.
     * @param {unknown} content - queue message content blocks.
     * @returns {string} joined text.
     */
    function textOfContent(content) {
      if (!Array.isArray(content)) return ''
      let text = ''
      for (const block of content) {
        if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
          text += block.text
        }
      }
      return text.trim()
    }

    /**
     * Classify one queue message for withdrawal. Images can be rehydrated
     * through the attachment read API; files and images both prefer the
     * temporary browser cache populated when they were selected.
     * @param {unknown} content - queue message content blocks.
     * @returns {{text: string, attachments: Array<object>, unsupported: boolean}} plan.
     */
    function withdrawPlan(content) {
      const text = textOfContent(content)
      const attachments = []
      let unsupported = false
      if (!Array.isArray(content)) return { text, attachments, unsupported: true }
      for (const block of content) {
        if (block === null || typeof block !== 'object') {
          unsupported = true
          continue
        }
        if (block.type === 'text') continue
        if (block.type === 'image' && typeof block.attachment?.attachmentId === 'string') {
          attachments.push({ type: 'image', ref: block.attachment })
          continue
        }
        if (block.type === 'file' && typeof block.attachment?.name === 'string'
          && typeof block.attachment?.bytes === 'number') {
          attachments.push({ type: 'file', ref: block.attachment })
          continue
        }
        unsupported = true
      }
      return { text, attachments, unsupported }
    }

    /**
     * File references still present in a queue window.
     * @param {object[]} queue - next-turn queue items.
     * @returns {Array<{name: string, size: number}>} file references.
     */
    function queuedFileRefs(queue) {
      const refs = []
      for (const item of Array.isArray(queue) ? queue : []) {
        for (const block of attachmentBlocksOf(item?.content)) {
          if (block.type !== 'file') continue
          refs.push({ name: String(block.ref.name ?? ''), size: Number(block.ref.bytes ?? 0) })
        }
      }
      return refs
    }

    /** @param {object} record @param {string} fallbackName @returns {File} restored browser file. */
    function fileFromCache(record, fallbackName) {
      if (record.file instanceof File) return record.file
      return new File([record.file], fallbackName, {
        type: typeof record.type === 'string' ? record.type : '',
        lastModified: typeof record.lastModified === 'number' ? record.lastModified : undefined,
      })
    }

    /**
     * Find the QueueDock roots owned by one conversation.
     * @param {string} sessionId - conversation id.
     * @returns {Element[]} queue dock roots.
     */
    function docksOf(sessionId) {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return []
      const all = [...document.querySelectorAll('[data-queue-dock]')]
      const docks = []
      const unowned = []
      for (const dock of all) {
        const owner = dock.closest?.('[data-conversation-session]')
        if (owner === null || owner === undefined) {
          unowned.push(dock)
          continue
        }
        if (owner.getAttribute?.('data-conversation-session') === sessionId) docks.push(dock)
      }
      // A single unscoped dock can only belong to this conversation. With more
      // than one, guessing risks decorating another Session's composer.
      return docks.length > 0 ? docks : (all.length === 1 ? unowned : [])
    }

    /**
     * The queue project's host rows, excluding local pending echoes.
     * @param {Element} dock - queue dock root.
     * @returns {Element[]} rows that correspond to host queue entries.
     */
    function hostRowsOf(dock) {
      if (typeof dock.querySelectorAll !== 'function') return []
      return [...dock.querySelectorAll('li')].filter((row) => row.hasAttribute?.('data-submission-echo') !== true)
    }

    /**
     * Put one action at the row's leading edge, before the queue icon and text.
     * @param {Element} row - host queue row.
     * @param {Element} button - injected action.
     */
    function placeButton(row, button) {
      if (typeof row.insertBefore === 'function') {
        row.insertBefore(button, row.firstChild ?? null)
        return
      }
      row.append?.(button)
    }

    /**
     * The global decoration layer. It renders no visible React tree; it
     * reconciles one injected button with each host queue row.
     * @param {object} props - session id, standard hooks, injected actions and translator.
     * @returns {null} no React output.
     */
    function QueueWithdraw({ sessionId, useSession, useProjection, actions, t }) {
      const inbox = useProjection('inbox')
      const queue = useMemo(() => (Array.isArray(inbox?.['next-turn']) ? inbox['next-turn'] : []), [inbox])
      const queueMutable = useSession((snapshot) => snapshot.subagent === null
        || snapshot.subagent?.address?.mode === 'continuable')
      const queueRef = useRef(queue)
      const mutableRef = useRef(queueMutable)
      const actionsRef = useRef(actions)
      const tRef = useRef(t)
      queueRef.current = queue
      mutableRef.current = queueMutable
      actionsRef.current = actions
      tRef.current = t
      const previousFileRefsRef = useRef([])
      useEffect(() => {
        const current = queuedFileRefs(queue)
        const removed = previousFileRefsRef.current.filter((old) => !current.some((ref) => ref.name === old.name && ref.size === old.size))
        if (removed.length > 0) void actionsRef.current.forgetCached?.(removed)
        previousFileRefsRef.current = current
      }, [queue])

      useEffect(() => {
        if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return undefined
        const buttonItems = new Map()
        const editItems = new Map()
        const editEntries = new Set()
        let frame = null
        let disposed = false
        const cancelFrame = () => {
          if (frame === null) return
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
          else clearTimeout(frame)
          frame = null
        }
        const schedule = () => {
          if (disposed || frame !== null) return
          if (typeof requestAnimationFrame === 'function') {
            frame = requestAnimationFrame(() => { frame = null; sync() })
          } else {
            frame = setTimeout(() => { frame = null; sync() }, 0)
          }
        }
        const removeButton = (button) => {
          buttonItems.delete(button)
          button.remove?.()
        }
        const syncButton = (button, item, text) => {
          buttonItems.set(button, item)
          button.dataset.dshItemId = String(item.id)
          const plan = withdrawPlan(item.content)
          const usable = !plan.unsupported && (plan.text !== '' || plan.attachments.length > 0)
          button.disabled = !usable
          button.title = !usable
            ? (plan.unsupported ? tRef.current('button.attachments') : tRef.current('button.empty'))
            : (plan.attachments.some?.((attachment) => attachment.type === 'file')
              ? tRef.current('button.cacheHint')
              : tRef.current('button.tooltip'))
          button.setAttribute?.('aria-label', button.title)
        }
        /** Withdraw one queue item through a row action. */
        const withdrawThrough = async (button, item) => {
          if (button.disabled) return
          button.disabled = true
          const accepted = await actionsRef.current.withdraw(
            item,
            tRef.current('button.empty'),
            tRef.current('button.failed'),
            tRef.current('button.attachments'),
            tRef.current('button.cacheMissing'),
          )
          if (accepted !== true) button.disabled = false
        }

        /**
         * Enable and redirect the Host edit control for attachment queues. The
         * Host edit path only accepts text; our redirect withdraws the whole
         * message (text + attachments) into the composer instead.
         */
        const syncHostEdit = (row, item) => {
          if (typeof row.querySelectorAll !== 'function') return
          const plan = withdrawPlan(item?.content)
          if (plan.unsupported || plan.attachments.length === 0) return
          let edit = null
          for (const candidate of row.querySelectorAll('button[aria-label]')) {
            if (candidate.hasAttribute?.('data-dsh-queue-withdraw') === true) continue
            const label = candidate.getAttribute?.('aria-label') ?? ''
            if (/编辑|Edit/i.test(label)) { edit = candidate; break }
          }
          if (edit === null) return
          editItems.set(edit, item)
          editEntries.add(edit)
          edit.disabled = false
          edit.title = tRef.current('button.editHint')
          if (edit.hasAttribute?.('data-dshq-edit') !== true) {
            edit.setAttribute?.('data-dshq-edit', '')
            edit.addEventListener('click', async (event) => {
              event.preventDefault?.()
              event.stopImmediatePropagation?.()
              event.stopPropagation?.()
              const current = editItems.get(edit)
              if (current !== undefined) await withdrawThrough(edit, current)
            }, true)
          }
        }

        const createButton = (row, item, text) => {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'dshqw-withdraw'
          button.setAttribute('data-dsh-queue-withdraw', '')
          button.innerHTML = WITHDRAW_ICON
          syncButton(button, item, text)
          button.addEventListener('click', (event) => {
            event.preventDefault?.()
            event.stopPropagation?.()
            const itemId = button.dataset.dshItemId
            const current = queueRef.current.find((candidate) => String(candidate.id) === itemId)
              ?? buttonItems.get(button)
            if (current === undefined) return
            void withdrawThrough(button, current)
          })
          placeButton(row, button)
          return button
        }
        const sync = () => {
          if (disposed) return
          const queueNow = mutableRef.current === true ? queueRef.current : []
          const docks = docksOf(sessionId)
          for (const dock of docks) {
            const rows = hostRowsOf(dock)
            for (let index = 0; index < rows.length; index += 1) {
              const item = queueNow[index]
              if (item === undefined) continue
              const text = textOfContent(item.content)
              let button = rows[index].querySelector?.('[data-dsh-queue-withdraw]')
              if (button === null || button === undefined) button = createButton(rows[index], item, text)
              else syncButton(button, item, text)
              syncHostEdit(rows[index], item)
            }
          }
          for (const button of [...buttonItems.keys()]) {
            if (button.isConnected === false) {
              buttonItems.delete(button)
              continue
            }
            const owned = docks.some((dock) => dock.contains?.(button))
            if (!owned) removeButton(button)
          }
        }
        const observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] })
        sync()
        return () => {
          disposed = true
          observer.disconnect()
          cancelFrame()
          for (const button of [...buttonItems.keys()]) button.remove?.()
          for (const edit of [...editEntries]) {
            edit.disabled = true
            edit.removeAttribute?.('data-dshq-edit')
          }
          editEntries.clear()
          editItems.clear()
          buttonItems.clear()
        }
      }, [sessionId, queueMutable])

      return null
    }

    /** Presentation only; colors and elevation come from the Host theme. */
    const CSS = `
.dshqw-withdraw {
  box-sizing: border-box;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dshqw-withdraw:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dshqw-withdraw:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}
.dshqw-withdraw:disabled {
  cursor: default;
  opacity: .4;
}
`

    /**
     * Register the queue-row decoration.
     * @param {object} ctx - Client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'queue-withdraw: dictionaries')
      ctx.effect(() => {
        if (typeof document === 'undefined' || typeof document.createElement !== 'function') return () => {}
        const style = document.createElement('style')
        style.dataset.dshPlugin = 'dsh-queue-withdraw'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => { style.remove?.() }
      }, 'queue-withdraw: styles')

      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'queue-withdraw',
        order: 21,
        locale: NS,
        inject: (sessionId) => {
          let conversation
          let shell
          try {
            const scope = ctx.sessions.scope(sessionId)
            conversation = scope?.get('conversation')
            shell = conversation?.input?.for?.(scope)
            ensureDraftCacheHook(conversation)
          } catch {
            conversation = undefined
            shell = undefined
          }
          const notify = (level, text) => {
            try {
              shell?.notify?.(level, text)
            } catch {
              // A disposed scope simply loses the non-critical notice.
            }
          }
          return {
            sessionId,
            actions: {
              /** Drop cache records for queue file references that left the queue. */
              forgetCached: (refs) => { void forgetCachedRefs(sessionId, refs) },
              /**
               * Move one queued message into the draft and remove it from the
               * Host queue. The draft is written before removal and restored if
               * removal is rejected.
               * @param {object} item - queue item with id and content.
               * @param {string} empty - empty-content notice.
               * @param {string} failure - failure notice.
               * @param {string} attachment - attachment notice.
               * @returns {Promise<boolean>} whether the item was withdrawn.
               */
              withdraw: async (item, empty, failure, attachment, cacheMissing = attachment) => {
                const plan = withdrawPlan(item?.content)
                if (plan.unsupported) {
                  notify('error', attachment)
                  return false
                }
                if (plan.text === '' && plan.attachments.length === 0) {
                  notify('error', empty)
                  return false
                }
                const binding = ctx.sessions.binding(sessionId)
                const session = binding?.session
                if (session === undefined || typeof session.updateQueue !== 'function') {
                  notify('error', failure)
                  return false
                }
                let previousDraft = ''
                try {
                  previousDraft = typeof shell?.snapshot?.draft === 'string' ? shell.snapshot.draft : ''
                } catch {
                  previousDraft = ''
                }
                let changedDraft = false
                const addedIds = []
                const releaseAdded = () => {
                  for (const id of addedIds) {
                    try { shell?.actions?.removeAttachment?.(id) } catch { /* best-effort */ }
                    try { conversation?.releaseDraftAttachment?.(id) } catch { /* best-effort */ }
                  }
                }
                const rollback = () => {
                  releaseAdded()
                  if (changedDraft) {
                    try { shell?.actions?.setDraft?.(previousDraft) } catch { /* best-effort restore */ }
                  }
                }
                const cachedRecords = []
                if (plan.attachments.length > 0) {
                  try {
                    if (typeof conversation?.createDrafts !== 'function'
                      || typeof shell?.actions?.addAttachments !== 'function'
                      || typeof File !== 'function') return false
                    const files = []
                    for (const block of plan.attachments) {
                      const ref = block.ref
                      const name = typeof ref.name === 'string' ? ref.name : ''
                      const size = typeof ref.bytes === 'number' ? ref.bytes : 0
                      const cached = name === '' ? null : await findCachedFile(sessionId, name, size)
                      if (cached !== null) {
                        cachedRecords.push(cached)
                        files.push(fileFromCache(cached, name))
                        continue
                      }
                      if (block.type !== 'image' || typeof session.readAttachment !== 'function') {
                        notify('error', cacheMissing)
                        return false
                      }
                      const result = await session.readAttachment(ref.attachmentId)
                      if (result?.ok !== true) throw new Error('image read failed')
                      const mediaType = result.value?.attachment?.mediaType ?? ref.mediaType
                      if (typeof mediaType !== 'string' || !mediaType.startsWith('image/')) throw new Error('not an image')
                      const fallbackName = result.value?.attachment?.name ?? ref.name ?? 'withdrawn-image'
                      files.push(new File([result.value.data], fallbackName, { type: mediaType }))
                    }
                    let drafts
                    try {
                      conversation.__dshQueueWithdrawRestoring = true
                      drafts = conversation.createDrafts(sessionId, files)
                    } finally {
                      conversation.__dshQueueWithdrawRestoring = false
                    }
                    for (const draft of drafts) {
                      if (draft?.id !== undefined) addedIds.push(draft.id)
                    }
                    if (addedIds.length !== files.length || shell.actions.addAttachments(addedIds) !== true) {
                      throw new Error('attachment draft rejected')
                    }
                  } catch {
                    releaseAdded()
                    notify('error', failure)
                    return false
                  }
                }
                if (plan.text !== '') {
                  try {
                    const nextDraft = previousDraft.trim() === ''
                      ? plan.text
                      : previousDraft.replace(/\s+$/, '') + '\n\n' + plan.text
                    shell?.actions?.setDraft?.(nextDraft)
                    changedDraft = true
                  } catch {
                    rollback()
                    notify('error', failure)
                    return false
                  }
                }
                try {
                  const result = await session.updateQueue(item.id, { kind: 'remove' })
                  if (result?.ok !== true) {
                    rollback()
                    notify('error', failure)
                    return false
                  }
                  // The queue row disappearing and the draft appearing are the
                  // feedback; an info notice would linger in the Host's notice
                  // surface and is unnecessary for a successful withdraw.
                  if (cachedRecords.length > 0) await forgetCachedRecords(cachedRecords)
                  return true
                } catch {
                  rollback()
                  notify('error', failure)
                  return false
                }
              },
            },
          }
        },
      }, QueueWithdraw))
    }

    return {
      /** Services this Client plugin waits for before applying. */
      inject: ['slots', 'locale', 'sessions'],
      apply,
    }
  },
})
