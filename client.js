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
      'button.editHint': '编辑并撤回到输入栏',
      'reorder.tooltip': '拖动排序排队消息',
      'reorder.failed': '排序失败，队列可能已变化',
      'button.empty': '这条排队消息没有可撤回的文本',
      'button.failed': '撤回失败，消息仍在队列中',
    }

    const en = {
      'button.label': 'Withdraw to input',
      'button.tooltip': 'Withdraw this queued message back into the composer',
      'button.attachments': 'This message contains attachment content that cannot be withdrawn',
      'button.cacheMissing': 'No local cache was found for this file attachment; it cannot be withdrawn',
      'button.cacheHint': 'Withdraw file attachment (uses this plugin\'s local cache)',
      'button.editHint': 'Edit and withdraw into the composer',
      'reorder.tooltip': 'Drag to reorder queued messages',
      'reorder.failed': 'Reorder failed; the queue may have changed',
      'merge.label': 'Merge queued messages',
      'merge.tooltip': 'Merge the queued text messages into one',
      'merge.failed': 'Merge failed; the queue may have changed',
      'merge.attachments': 'Messages with attachments cannot be merged',
      'button.empty': 'This queued message has no text to withdraw',
      'button.failed': 'Withdraw failed; the message is still queued',
    }

    /** Icon used by the injected row action. */
  /** Drag handle icon. */
  const HANDLE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="6" cy="4" r="1"/><circle cx="10" cy="4" r="1"/><circle cx="6" cy="8" r="1"/><circle cx="10" cy="8" r="1"/><circle cx="6" cy="12" r="1"/><circle cx="10" cy="12" r="1"/></svg>'

  const REORDER_PATH = '/dsh-queue-withdraw/reorder'

    /** Short-lived browser cache of files selected before a queue submission. */
    const CACHE_DB = 'dsh-queue-withdraw'
    const CACHE_STORE = 'files'
    const CACHE_TTL_MS = 24 * 60 * 60 * 1000
    const memoryCache = []
  /** Draft attachment id to selected browser File, for session-switch restoration. */
  const draftFiles = new Map()
  /** Files attached to a composer when its session was unmounted. */
  const pendingDraftFiles = new Map()
  /** Last attachment ids observed in each session's composer. */
  const trackedDraftAttachments = new Map()
  /** Per-session callback that snapshots the composer attachments. */
  const draftSavers = new Map()
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
    /** Persist tracked ids for a session as pending files when it is left. */
    function saveTrackedDraftFiles(sessionId) {
      const ids = trackedDraftAttachments.get(sessionId) ?? []
      if (ids.length === 0) {
        pendingDraftFiles.delete(sessionId)
        return
      }
      const files = ids.map((id) => draftFiles.get(id)).filter((file) => file !== undefined)
      if (files.length === ids.length) pendingDraftFiles.set(sessionId, files)
    }

    /** @param {unknown} value @returns {string|undefined} session id. */
    function sessionIdOfValue(value) {
      if (typeof value === 'string') return value
      if (value !== null && typeof value === 'object') return value.key ?? value.sessionId
      return undefined
    }

    function ensureDraftCacheHook(conversation) {
      if (conversation === null || conversation === undefined) return
      if (typeof conversation.createDrafts !== 'function') return
      if (conversation.__dshQueueWithdrawCache === true) return
      try {
        const original = conversation.createDrafts.bind(conversation)
        conversation.createDrafts = (sessionId, files) => {
          const drafts = original(sessionId, files)
          drafts.forEach((draft, index) => {
            if (typeof draft?.id === 'string' && files[index] !== undefined) draftFiles.set(draft.id, files[index])
          })
          if (conversation.__dshQueueWithdrawRestoring !== true) rememberFiles(sessionId, files)
          setTimeout(() => draftSavers.get(sessionId)?.(true), 0)
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
        const timer = setInterval(() => actionsRef.current.saveDraftAttachments?.(), 100)
        return () => {
          clearInterval(timer)
          actionsRef.current.saveDraftAttachments?.()
        }
      }, [])

      useEffect(() => {
        const timer = setTimeout(() => { void actionsRef.current.restoreDraftAttachments?.() }, 0)
        return () => clearTimeout(timer)
      }, [])

      useEffect(() => {
        if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return undefined
        const editItems = new Map()
        const editEntries = new Set()
        const handleItems = new WeakMap()
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
        /** Withdraw one queue item through the Host edit control. */
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

        /** Whether a pointer drag is currently moving a queue row. */
        let dragging = false

        /** Give one row a drag handle and a full-row pointer drag ghost. */
        const createHandle = (row, item) => {
          if (typeof row.querySelector !== 'function' || typeof row.insertBefore !== 'function') return null
          const handle = document.createElement('button')
          handle.type = 'button'
          handle.className = 'dshqw-handle'
          handle.setAttribute('data-dshq-handle', '')
          handle.setAttribute('aria-label', tRef.current('reorder.tooltip'))
          handle.title = tRef.current('reorder.tooltip')
          handle.innerHTML = HANDLE_ICON
          handleItems.set(handle, item)
          handle.addEventListener('dragstart', (event) => {
            event.dataTransfer?.setData('application/x-dshq-item', String(item.id))
            event.dataTransfer?.setData('text/plain', String(item.id))
            if (event.dataTransfer !== null && event.dataTransfer !== undefined) event.dataTransfer.effectAllowed = 'move'
          })
          row.addEventListener('dragover', (event) => {
            const types = event.dataTransfer?.types
            if (types === null || types === undefined || !Array.from(types).includes('application/x-dshq-item')) return
            event.preventDefault?.()
            if (event.dataTransfer !== null && event.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'move'
          })
          row.addEventListener('drop', async (event) => {
            const source = event.dataTransfer?.getData?.('application/x-dshq-item')
            if (source === null || source === undefined || source === '') return
            const targetHandle = row.querySelector?.('[data-dshq-handle]')
            const target = targetHandle === null || targetHandle === undefined ? undefined : handleItems.get(targetHandle)
            if (target === undefined || source === String(target.id)) return
            event.preventDefault?.()
            event.stopPropagation?.()
            const order = queueRef.current.map((entry) => String(entry.id))
            const from = order.indexOf(source)
            const to = order.indexOf(String(target.id))
            if (from < 0 || to < 0) return
            order.splice(from, 1)
            order.splice(to, 0, source)
            await actionsRef.current.reorder(order, tRef.current('reorder.failed'))
          })
          handle.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return
            const current = handleItems.get(handle)
            if (current === undefined) return
            const dock = row.closest?.('[data-queue-dock]') ?? row.parentElement
            if (dock === null || dock === undefined) return
            const initial = hostRowsOf(dock).map((entry) => {
              const entryHandle = entry.querySelector?.('[data-dshq-handle]')
              return entryHandle === null || entryHandle === undefined ? undefined : handleItems.get(entryHandle)?.id
            }).filter((id) => id !== undefined).map(String)
            const startX = event.clientX
            const startY = event.clientY
            const rowRect = row.getBoundingClientRect()
            const offsetX = event.clientX - rowRect.left
            const offsetY = event.clientY - rowRect.top
            let ghost = null
            let started = false
            const moveGhost = (pointerEvent) => {
              if (ghost === null) return
              ghost.style.left = (pointerEvent.clientX - offsetX) + 'px'
              ghost.style.top = (pointerEvent.clientY - offsetY) + 'px'
            }
            const begin = (pointerEvent) => {
              started = true
              dragging = true
              const rect = row.getBoundingClientRect()
              ghost = row.cloneNode(true)
              ghost.classList.add('dshqw-drag-ghost')
              ghost.style.width = rect.width + 'px'
              ghost.style.height = rect.height + 'px'
              ghost.style.left = rect.left + 'px'
              ghost.style.top = rect.top + 'px'
              row.classList.add('dshqw-drag-source')
              document.body.appendChild(ghost)
              moveGhost(pointerEvent)
            }
            const move = (pointerEvent) => {
              if (!started) {
                if (Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY) < 3) return
                begin(pointerEvent)
              }
              pointerEvent.preventDefault?.()
              moveGhost(pointerEvent)
              const target = document.elementFromPoint?.(pointerEvent.clientX, pointerEvent.clientY)?.closest?.('li')
              if (target === null || target === undefined || target === row) return
              const rows = hostRowsOf(dock).filter((entry) => entry !== row)
              if (!rows.includes(target)) return
              const rect = target.getBoundingClientRect()
              const before = pointerEvent.clientY < rect.top + rect.height / 2
              target.parentNode?.insertBefore(row, before ? target : target.nextSibling)
            }
            const finish = async () => {
              document.removeEventListener?.('pointermove', move, true)
              document.removeEventListener?.('pointerup', finish, true)
              document.removeEventListener?.('pointercancel', finish, true)
              ghost?.remove?.()
              row.classList.remove('dshqw-drag-source')
              dragging = false
              if (!started) return
              const order = hostRowsOf(dock).map((entry) => {
                const entryHandle = entry.querySelector?.('[data-dshq-handle]')
                const targetItem = entryHandle === null || entryHandle === undefined ? undefined : handleItems.get(entryHandle)
                return targetItem === undefined ? undefined : String(targetItem.id)
              }).filter((id) => id !== undefined)
              if (order.length !== initial.length || order.some((id, index) => id !== initial[index])) {
                await actionsRef.current.reorder(order, tRef.current('reorder.failed'))
              }
            }
            document.addEventListener?.('pointermove', move, true)
            document.addEventListener?.('pointerup', finish, true)
            document.addEventListener?.('pointercancel', finish, true)
          })
          row.insertBefore(handle, row.firstChild ?? null)
          return handle
        }

        /**
         * Make the Host edit control the single queue action. Every edit is a
         * withdraw: text plus attachments are moved back into the composer, so
         * the Host's text-only inline editor never drops attachment blocks.
         * Attachment rows need their disabled edit control re-enabled; plain
         * text rows keep their native enabled state.
         */
        const syncHostEdit = (row, item) => {
          if (typeof row.querySelectorAll !== 'function') return
          const plan = withdrawPlan(item?.content)
          if (plan.unsupported || (plan.text === '' && plan.attachments.length === 0)) return
          let edit = null
          for (const candidate of row.querySelectorAll('button[aria-label]')) {
            if (candidate.hasAttribute?.('data-dsh-queue-withdraw') === true) continue
            const label = candidate.getAttribute?.('aria-label') ?? ''
            if (/编辑|Edit/i.test(label)) { edit = candidate; break }
          }
          if (edit === null) return
          editItems.set(edit, item)
          editEntries.add(edit)
          if (plan.attachments.length > 0) edit.disabled = false
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
        const sync = () => {
          if (disposed || dragging) return
          const queueNow = mutableRef.current === true ? queueRef.current : []
          const docks = docksOf(sessionId)
          for (const dock of docks) {
            const rows = hostRowsOf(dock)
            for (let index = 0; index < rows.length; index += 1) {
              const item = queueNow[index]
              if (item === undefined) continue
              const row = rows[index]
              let handle = row.querySelector?.('[data-dshq-handle]')
              if (handle === null || handle === undefined) handle = createHandle(row, item)
              else handleItems.set(handle, item)
              syncHostEdit(row, item)
            }
            syncMergeButton(dock)
          }
        }

        /** Add or refresh the merge action for one queue dock. */
        const syncMergeButton = (dock) => {
          if (typeof dock.appendChild !== 'function') return
          let merge = dock.querySelector?.('[data-dshq-merge]')
          if (merge === null || merge === undefined) {
            merge = document.createElement('button')
            merge.type = 'button'
            merge.className = 'dshqw-merge'
            merge.setAttribute('data-dshq-merge', '')
            merge.addEventListener('click', async () => {
              if (merge.disabled === true) return
              merge.disabled = true
              const accepted = await actionsRef.current.mergeQueue(
                queueRef.current,
                tRef.current('merge.failed'),
                tRef.current('merge.attachments'),
              )
              if (merge !== null) merge.disabled = false
            })
            dock.appendChild(merge)
          }
          const count = queueRef.current.length
          merge.textContent = tRef.current('merge.label') + (count > 1 ? ' (' + String(count) + ')' : '')
          merge.title = tRef.current('merge.tooltip')
          merge.hidden = count < 2 || mutableRef.current !== true
        }
        const observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] })
        sync()
        return () => {
          disposed = true
          observer.disconnect()
          cancelFrame()
          for (const handle of document.querySelectorAll?.('[data-dshq-handle]') ?? []) handle.remove?.()
          for (const merge of document.querySelectorAll?.('[data-dshq-merge]') ?? []) merge.remove?.()
          for (const edit of [...editEntries]) {
            if (edit.hasAttribute?.('data-dshq-edit') === true) edit.disabled = true
            edit.removeAttribute?.('data-dshq-edit')
          }
          editEntries.clear()
          editItems.clear()
        }
      }, [sessionId, queueMutable])

      return null
    }

    /** Presentation only; colors and elevation come from the Host theme. */
    const CSS = `
.dshqw-handle {
  box-sizing: border-box;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: grab;
  opacity: .45;
}
.dshqw-handle:hover {
  color: var(--dsw-alias-label-primary);
  opacity: 1;
}
.dshqw-handle:active {
  cursor: grabbing;
}
.dshqw-handle:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}
.dshqw-drag-source {
  opacity: .28;
  transition: opacity 120ms ease;
}
.dshqw-drag-ghost {
  position: fixed;
  z-index: 140;
  box-sizing: border-box;
  pointer-events: none;
  opacity: .72;
  border-radius: 10px;
  background: var(--dsw-alias-bg-base);
  box-shadow: var(--dsw-elevation-soft);
  overflow: hidden;
}
.dshqw-merge {
  align-self: flex-start;
  margin: 4px 0 0 24px;
  padding: 2px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.dshqw-merge:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dshqw-merge[hidden] { display: none; }
`

    /**
     * Register the queue-row decoration.
     * @param {object} ctx - Client root context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const uiSession = typeof ctx.get === 'function' ? ctx.get('uiSession') : undefined
        const current = uiSession?.current
        if (current === undefined || typeof current.subscribe !== 'function') return () => {}
        let previous = sessionIdOfValue(current.value)
        const unsubscribe = current.subscribe(() => {
          const next = sessionIdOfValue(current.value)
          if (next === previous) return
          if (previous !== undefined) saveTrackedDraftFiles(previous)
          previous = next
        })
        return () => unsubscribe?.()
      }, 'queue-withdraw: draft attachment switch tracking')
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
          const scheduleSave = () => setTimeout(() => { try { saveDraftAttachmentsNow() } catch { /* best effort */ } }, 0)
          const saveDraftAttachmentsNow = () => {
            try {
              const ids = shell?.snapshot?.attachmentIds
              if (Array.isArray(ids)) trackedDraftAttachments.set(sessionId, [...ids])
            } catch {
              // ignored
            }
            saveTrackedDraftFiles(sessionId)
          }
          draftSavers.set(sessionId, (immediate) => {
            if (immediate === true) setTimeout(saveDraftAttachmentsNow, 0)
            else scheduleSave()
          })
          try {
            if (typeof shell?.addFiles === 'function' && shell.__dshDraftTracked !== true) {
              const originalAddFiles = shell.addFiles.bind(shell)
              shell.addFiles = (...args) => {
                const result = originalAddFiles(...args)
                scheduleSave()
                return result
              }
              shell.__dshDraftTracked = true
            }
            const removeAttachment = shell?.removeAttachment
            if (typeof removeAttachment === 'function' && removeAttachment.__dshTracked !== true) {
              const wrapped = (id) => {
                const result = removeAttachment(id)
                scheduleSave()
                return result
              }
              wrapped.__dshTracked = true
              shell.removeAttachment = wrapped
            }
          } catch {
            // A frozen facade cannot be decorated; polling still tracks ids.
          }
          return {
            sessionId,
            actions: {
              /** Drop cache records for queue file references that left the queue. */
              forgetCached: (refs) => { void forgetCachedRefs(sessionId, refs) },
              /** Remember the files currently attached to this composer before unmount. */
              saveDraftAttachments: () => {
                try {
                  const snapshotIds = shell?.snapshot?.attachmentIds
                  if (Array.isArray(snapshotIds)) {
                    trackedDraftAttachments.set(sessionId, [...snapshotIds])
                  }
                } catch {
                  // A disposed shell has no snapshot; the tracked ids remain usable.
                }
                saveTrackedDraftFiles(sessionId)
              },
              /** Re-add files saved from this session's previous composer mount. */
              restoreDraftAttachments: async () => {
                const files = pendingDraftFiles.get(sessionId)
                if (files === undefined || files.length === 0) return
                try {
                  for (let attempt = 0; attempt < 20; attempt += 1) {
                    const ids = shell?.snapshot?.attachmentIds
                    if (!Array.isArray(ids)) {
                      await new Promise((resolve) => setTimeout(resolve, 50))
                      continue
                    }
                    if (ids.length > 0 || typeof conversation?.createDrafts !== 'function'
                      || typeof shell?.actions?.addAttachments !== 'function') break
                    const drafts = conversation.createDrafts(sessionId, files)
                    const restoredIds = drafts.map((draft) => draft?.id).filter((id) => typeof id === 'string')
                    if (restoredIds.length === files.length && shell.actions.addAttachments(restoredIds) === true) break
                    await new Promise((resolve) => setTimeout(resolve, 50))
                  }
                } catch {
                  // Best effort: the draft text itself is still persisted by DSH.
                } finally {
                  pendingDraftFiles.delete(sessionId)
                }
              },
              /**
               * Persist one complete next-turn order through the Host route.
               * @param {string[]} order - every live queue id in the desired order.
               * @param {string} failure - localized failure notice.
               * @returns {Promise<boolean>} whether the Host applied the order.
               */
              reorder: async (order, failure) => {
                try {
                  const response = await fetch(REORDER_PATH, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ sessionId, order }),
                  })
                  const body = await response.json?.()
                  if (response.ok !== true || body?.ok !== true) {
                    notify('error', failure)
                    return false
                  }
                  return true
                } catch {
                  notify('error', failure)
                  return false
                }
              },
              /**
               * Merge queued pure-text messages into the first one. Attachments
               * are refused because the Host's queue edit accepts text only.
               * @param {object[]} items - current next-turn queue.
               * @param {string} failure - merge failure notice.
               * @param {string} attachment - attachment refusal notice.
               * @returns {Promise<boolean>} whether the queue was merged.
               */
              mergeQueue: async (items, failure, attachment) => {
                const list = Array.isArray(items) ? items : []
                if (list.length < 2) return false
                const plans = list.map((entry) => ({ item: entry, plan: withdrawPlan(entry?.content) }))
                if (plans.some((entry) => entry.plan.unsupported || entry.plan.attachments.length > 0)) {
                  notify('error', attachment)
                  return false
                }
                const texts = plans.map((entry) => entry.plan.text).filter((text) => text.trim() !== '')
                if (texts.length < 2) return false
                const binding = ctx.sessions.binding(sessionId)
                const session = binding?.session
                if (session === undefined || typeof session.updateQueue !== 'function') {
                  notify('error', failure)
                  return false
                }
                const merged = texts.join('\n\n')
                try {
                  const first = await session.updateQueue(list[0].id, {
                    kind: 'edit',
                    content: [{ type: 'text', text: merged }],
                  })
                  if (first?.accepted !== true && first?.ok !== true) throw new Error('merge rejected')
                  for (const entry of list.slice(1)) {
                    const removed = await session.updateQueue(entry.id, { kind: 'remove' })
                    if (removed?.accepted !== true && removed?.ok !== true) throw new Error('remove rejected')
                  }
                  return true
                } catch {
                  notify('error', failure)
                  return false
                }
              },
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
