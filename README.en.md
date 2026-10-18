# dsh-queue-withdraw

[简体中文](README.md) | English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web client plugin that adds
**withdraw back into the composer** to queued messages, instead of only edit, delete or steer.

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.2-4D6BFE)
![Version](https://img.shields.io/badge/version-1.2.0-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-green)
![Runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)
![Checks](https://img.shields.io/badge/checks-19-brightgreen)

## Why

DSH's queued-message row offers edit, delete and steer. To take a message back and adjust it, delete
loses the content and edit is less direct than restoring the composer.

`dsh-queue-withdraw` appends one withdraw action to every queued row:

- restores the queued text to the composer
- removes the item through `Session.updateQueue(itemId, { kind: 'remove' })`
- appends to an existing draft instead of overwriting it
- restores the previous draft if the Host rejects the removal
- **image attachments** use the temporary cache first, then fall back to `session.readAttachment()`
- **file attachments** are supported by caching the browser `File` in IndexedDB before the Host
  uploads it; withdrawing registers it as a draft file again so DSH re-uploads it normally

## Temporary file cache

The queue only stores `attachmentId + name + bytes`; the file content exists only at selection time.
The plugin wraps `conversation.createDrafts()` and keeps a temporary copy:

1. the user selects files and the Host creates draft attachments;
2. the plugin writes each `File` to IndexedDB (with a synchronous in-memory copy for this page);
3. the message is queued, while its cache stays available;
4. on withdraw the cache is matched by `name + size` and restored through `createDrafts` +
   `addAttachments`;
5. successful withdrawal, the queue item leaving the queue, or a 24-hour age cleans the cache.

The cache lives in this browser profile's IndexedDB. It is not uploaded to the Host and does not
change the queue protocol.

## Behaviour

- decorates only Host `[data-queue-dock]` rows; local pending echoes are skipped
- the action hides with the row while the queue is collapsed and returns when expanded
- the queue itself stays owned by DSH's QueueDock
- no action is injected when the conversation queue is immutable (subagents)

Withdraw flow:

1. read text and attachment blocks from the queued message;
2. prefer the temporary cache; images without a cache fall back to `session.readAttachment()`;
3. add attachments through the conversation draft registry, then append the text to the draft;
4. call the public `session.updateQueue(itemId, { kind: 'remove' })`;
5. on success the row disappears and the draft is already visible, so no persistent success notice
   is shown; on failure the old draft is restored and an error is reported.

## Install

### Plugin Manager (recommended)

In a session with the Creator preset:

```text
plugin_manager(action="install_bundle", target="<absolute path of this directory>")
```

`target` must be absolute. If the profile already has the same bundle, remove it first and install
again.

### Manual install (development)

1. Make the package resolvable from the profile:

   ```powershell
   $profile = "$env:USERPROFILE\.dsh\profiles\desktop"
   New-Item -ItemType Directory -Force -Path "$profile\node_modules" | Out-Null
   New-Item -ItemType Junction -Path "$profile\node_modules\dsh-queue-withdraw" `
            -Target "<absolute path of this directory>"
   ```

2. Add a `link:` dependency to the profile `package.json` and append the package name to
   `dsh.profile.bundles`. A dependency change alone does not trigger recomposition; the ordered
   bundle list must change.

### Requirements

- DeepSeek Harness `0.2.1-rc.2` (Web or Desktop Web UI)
- no build step, no runtime dependencies

## Implementation

The plugin registers in `conversation.input.dock`, reads the `next-turn` queue through
`useProjection('inbox')`, and uses standard Session actions:

1. a MutationObserver tracks `[data-queue-dock]` and appends one compact action to each Host row;
2. the session injection decorates `conversation.createDrafts` once to cache selected `File`s;
3. the action supports text, images and file attachments; a missing file cache leaves the queue and
   draft untouched and reports that the file must be selected again;
4. clicking writes attachments and text into the draft, then calls `updateQueue(remove)`;
5. caches are cleaned when the queue item leaves the queue; failures restore the draft and report an
   error.

No remote API is added and the QueueDock edit/delete/steer behaviour is unchanged.

## Known limitations

- **only files selected after the plugin loaded are cached**; older queued files cannot be restored
  and report a missing cache
- clearing site data, private browsing, an IndexedDB write failure or a cache older than 24 hours can
  make a file unrestorable
- cache matching uses `name + size`; identical name/size files may match the most recent cache entry
- a queue item kept longer than 24 hours can lose its cache during cleanup
- image restoration relies on the conversation draft registry (`createDrafts` / `addAttachments`) and
  may need compatibility updates after a DSH upgrade
- the queue must be visible in the current conversation view; expand a collapsed queue to see the
  action
- immutable subagent queues are skipped
- existing draft text is preserved and the withdrawn text is appended
- DSH client APIs are pre-stable; DOM/attribute contracts may need updates on DSH upgrades

## Development and tests

```sh
node scripts/check.mjs
```

The zero-dependency suite covers manifest/patch/locale, queue extraction, successful and rejected
withdrawal, draft restoration, image rehydration, cached file restoration, cache cleanup, Host row
injection and theme styling — 19 checks.

## License

[MIT](LICENSE)
