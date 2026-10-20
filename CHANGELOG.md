## [1.11.5] - 2026-10-19

### Changed

- Swapped the two injected actions: the lock now sits just before the Host action cluster, and the
  withdraw action sits at the row's trailing edge after it. Both keep the 28x28 geometry.

### Verified

- `node scripts/check.mjs`: 40 checks green.

## [1.11.4] - 2026-10-19

### Fixed

- Row actions now match the Host icons geometrically, measured from real screenshots:
  - the lock button still carried a leftover `20x22` override, so its hit box and hover circle were
    smaller than the Host's `28x28` action and its centre sat 34px from the neighbour instead of 38px.
    The override is gone; both injected actions are `28x28` circles.
  - the lock/unlock/withdraw glyphs were drawn inside a padded 16-unit viewBox, so their visible
    strokes were ~11-12px wide against the Host's 13-15px. Both icons now use a tight viewBox that
    fills the 14px icon box.

### Verified

- `node scripts/check.mjs`: 40 checks green.

## [1.11.3] - 2026-10-19

### Fixed

- Submit-time jitter: the live probe showed the Host re-creates queue rows when the queue changes, so
  the injected actions are re-added. The withdraw action used to sit at the leading edge, pushing the
  text right whenever it was re-created. It now sits next to the native action cluster, so the left
  text edge never moves and only the trailing icons are re-added.

### Added

- Diagnostics extended for the jitter hunt: `row-replaced` (item moved to a new DOM row node),
  `text-shift` (preview text moved between the two injections), and `dock-geometry` now also carries
  whether the header is mounted and whether the list is hidden.

## [1.11.2] - 2026-10-19

### Added

- Temporary jitter diagnostics: `decorate` (per-row action creation, with a `recreated` flag for
  churn), `buttons-dropped` (a decorated row lost its actions), and `dock-geometry` (dock top/height/
  row/echo-count changes). They append to the same `$DSH_HOME/queue-withdraw-diag.jsonl` sink; remove
  once the submit-time jitter is understood.

## [1.11.1] - 2026-10-19

### Fixed

- Withdraw and lock now match the Host's action buttons exactly: 28x28 circle, 14px tertiary glyph,
  the same hover pill, focus ring and disabled treatment (no extra base opacity).
- The dock no longer flashes or shifts when a queued message is submitted or edited:
  - decoration now runs inside the MutationObserver callback (right after React commits, before
    paint) instead of a later animation frame, so a freshly rendered row never paints without its
    actions;
  - the lock button is appended only when it is created, not re-appended whenever React re-renders
    the row around it;
  - the layout diagnostic probe is deferred to an animation frame instead of forcing layout inside
    the commit path.

### Verified

- `node scripts/check.mjs`: 38 checks green.

## [1.11.0] - 2026-10-19

### Changed

- Removed the drag handle icon. The whole queue row is now the drag source: pressing and moving more
  than 3px starts the drag with the same ghost, drop hints, merge and composer-withdraw targets.
  Buttons, the inline editor and images keep their own presses, and the row shows a grab cursor.

### Verified

- `node scripts/check.mjs`: 38 checks green.

## [1.10.2] - 2026-10-19

### Added

- Temporary layout probe: when visible space appears between the queue dock and the composer, the
  client posts the dock/composer geometry to `POST /dsh-queue-withdraw/diag`, which appends it to
  `$DSH_HOME/queue-withdraw-diag.jsonl`. Used to pin the intermittent dock/composer gap; remove once
  the cause is fixed.

## [1.10.1] - 2026-10-19

### Changed

- Hide the Host's own per-row queue icon (`[class*="lead"]` inside a dock row). It is only rendered
  when a single message is queued, and the injected leading actions make it redundant.

### Verified

- `node scripts/check.mjs`: 38 checks green.

## [1.10.0] - 2026-10-19

### Changed

- Freeze is now **lock**. Each queued message gets a small lock at the dock's trailing edge, outside
  the native action cluster, and it locks or unlocks that one message.
- A locked message is struck through and its Host edit control is disabled; the blue edge indicator is
  gone. Locked messages stay queued but the Host claim skips them, so they are not auto-sent; they can
  still be withdrawn and reordered.
- Unlocking drops the id from the Host set, so the message is immediately sendable again at the next
  turn boundary.
- Withdrawing a locked message also drops its lock id.

### Verified

- `node scripts/check.mjs`: 38 checks green.

## [1.9.1] - 2026-10-19

### Changed

- Queued text messages now use the Host's own inline editor; the plugin no longer intercepts the
  edit control. It only wraps `conversation.updateQueue` so a native text edit keeps the message's
  existing image/file blocks.
- The plugin editor remains only as a fallback for attachment-only messages, where the Host disables
  editing.

### Verified

- `node scripts/check.mjs`: 37 checks green.

## [1.9.0] - 2026-10-19

### Changed

- Freezing no longer removes the message from `next-turn`: the Host keeps a persisted held-id set and
  the inbox `claim` entry skips those ids at the turn boundary, so every native queue control keeps
  working and the message simply is not auto-submitted.
- The frozen row is the native row with a `dshqw-frozen-row` marker (fainter text, no strike-through)
  and the snowflake switched to `Unfreeze`.

### Added

- Host routes `POST /dsh-queue-withdraw/freeze` (adds the id), `POST /dsh-queue-withdraw/thaw`
  (removes it) and `POST /dsh-queue-withdraw/frozen` (lists this conversation's ids).
- Held ids persist to `$DSH_HOME/queue-withdraw-frozen.json` and are re-loaded on boot.

### Verified

- `node scripts/check.mjs`: 35 checks green.

## [1.8.0] - 2026-10-19

### Added

- Freeze action on every queued row: the message is held out of `next-turn` (so the ending turn does
  not send it) while a disabled placeholder row stays at its slot in the queue list.
- Host routes `POST /dsh-queue-withdraw/freeze` (returns the message and its slot) and
  `POST /dsh-queue-withdraw/thaw` (re-inserts at the saved slot, clamped).
- In-list frozen row keeps every queue control (handle, withdraw, Host edit/delete/steer) but
  disables them, and turns the snowflake into `Unfreeze`; when every message is frozen the Host
  unmounts its dock, so the plugin renders a fallback in the same slot that reuses the class names
  and button glyphs captured from the live Host dock (native look), hidden by
  `body:has([data-queue-dock])` while the Host dock is mounted.

### Verified

- `node scripts/check.mjs`: 37 checks green.

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
