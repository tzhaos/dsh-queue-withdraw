## [1.7.1] - 2026-10-19

### Fixed

- Sync the package version with the 1.7.0 behavior release after a concurrent profile/docs edit.
- README now describes inline editing, separate withdraw, drag-merge and attachment previews.

### Verified

- `node scripts/check.mjs`: 26 checks green.

## [1.7.0] - 2026-10-19

### Added

- Inline queue editing through a custom editor: text, existing attachment removal, and new
  attachment uploads all save through a Host update route that preserves image/file blocks.
- Separate withdraw action; withdrawing now replaces the composer text and attachments instead of
  appending to the current draft.
- Drag-to-merge: dropping a queue row on another row's lower merge zone appends the dragged
  message to the target tail (attachments included) through the Host route.
- Drag a queue row onto the composer to withdraw it.
- Queued image thumbnails open a click-to-zoom preview.

### Fixed

- Suppress the Host hover/tooltip on the intercepted edit control.
- Remove the global merge button; merging is now a drag gesture.

### Verified

- `node scripts/check.mjs`: 26 checks green.

## [1.6.2] - 2026-10-19

### Fixed

- Hide the merge footer while the queue list is collapsed; observe the list's `hidden` attribute so
  the collapsed card stays compact.

### Verified

- `node scripts/check.mjs`: 26 checks green.

## [1.6.1] - 2026-10-19

### Fixed

- Add the missing Chinese merge labels; the queue action no longer falls back to English.
- Put the merge action inside the queue card as a small footer chip instead of appending an
  unlabeled text line to the dock.
- Shorten the label to `合并 N` / `Merge N`.

### Verified

- `node scripts/check.mjs`: 26 checks green.

## [1.6.0] - 2026-10-19

### Added

- Drag a queued row by its handle with a semi-transparent full-row ghost following the pointer;
  the source row remains in flow and moves live so the other rows make room.
- Add a queue-dock Merge action that combines pure-text queued messages into the first item.
  Messages with attachments are refused because the Host queue edit accepts text only.

### Verified

- `node scripts/check.mjs`: 26 checks green.

# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.1] - 2026-10-19

### Fixed

- Track composer attachment ids immediately from the input facade and on the active-session switch,
  not only from a slow poll. Switching conversations now saves the latest set before the old scope is
  released and restores it when returning.

### Verified

- `node scripts/check.mjs`: 22 checks green.

## [1.5.0] - 2026-10-19

### Added

- Composer image/file attachments are kept in memory while switching conversations and re-added when
  returning to the original session. The existing draft text persistence is unchanged.

### Verified

- `node scripts/check.mjs`: 22 checks green.

## [1.4.0] - 2026-10-19

### Changed

- The Host edit icon is now the single queue action for every supported message. Clicking it always
  withdraws the whole message (text + attachments) into the composer instead of opening the
  text-only inline editor; the separate left-side withdraw button is removed.
- Added drag reordering for queued messages through a leading handle. The Host half exposes
  `/dsh-queue-withdraw/reorder`, validates the full `next-turn` id order and applies it atomically
  through `Inbox.splice()`.

### Verified

- `node scripts/check.mjs`: 21 checks green.

## [1.3.0] - 2026-10-19

### Added

- Messages containing image or file attachments are editable: the Host edit action is enabled and
  redirected to withdraw the complete message into the composer, where text and attachments can be
  changed before sending again.

### Verified

- `node scripts/check.mjs`: 20 checks green.

## [1.2.1] - 2026-10-19

### Changed

- Moved the queue-withdraw action from the right-side action cluster to the leading edge of the
  queued row, so it is not adjacent to edit/delete/steer and is less likely to be hit accidentally.

### Verified

- `node scripts/check.mjs`: 19 checks green, including the leading-edge placement assertion.

## [1.2.0] - 2026-10-18

### Added

- File attachments can now be withdrawn. The plugin wraps the conversation draft registry once and
  caches each selected browser `File` in IndexedDB (plus a synchronous in-memory copy) before the
  Host uploads it.
- Withdrawing a queued file looks the cache up by `name + size`, registers a draft file again and
  lets DSH re-upload it normally.
- Caches are removed when the queue item leaves the queue, after a successful withdrawal, or once
  they are older than 24 hours.
- The file action explains that it uses the local cache; old queued files with no cache report a
  missing-cache error without touching the queue or draft.

### Verified

- `node scripts/check.mjs`: 19 checks green, including cached file restoration, missing-cache
  refusal and cache cleanup.

## [1.1.1] - 2026-10-18

### Fixed

- Removed the persistent “Moved back into the composer” success notice. The queue row disappearing
  and the restored draft are already visible feedback; the Host notice surface kept the info toast
  on screen indefinitely. Failure notices are still reported.

### Verified

- `node scripts/check.mjs`: 17 checks green; successful withdrawal expects no notice.

## [1.1.0] - 2026-10-18

### Added

- Image attachments on queued messages can now be withdrawn. The image bytes are read through the
  Session and rebuilt as browser draft files in the conversation draft-attachment registry before
  the queue item is removed.
- Image-only queue items are withdrawable; text and images are restored together.

### Changed

- File attachments remain unsupported: the Host exposes image reads only and has no public file
  attachment restore path.
- The attachment tooltip now distinguishes the supported image case from the unsupported file case.

### Verified

- `node scripts/check.mjs`: 17 checks green, including image rehydration and file-attachment refusal.

## [1.0.0] - 2026-10-18

### Added

- Withdraw to input action on each rendered Host queue row.
- Queued text is appended to the current composer draft and removed through
  `Session.updateQueue(itemId, { kind: 'remove' })`.
- Draft restoration when Host removal is rejected.
- Attachment protection: messages with images/files stay in the queue and the action is disabled.
- Localized label, tooltip and success/error notices.

### Verified

- `node scripts/check.mjs`: initial suite (15 checks).
- Built against DeepSeek Harness `0.2.1-rc.2`; client and DOM contracts remain pre-stable.
