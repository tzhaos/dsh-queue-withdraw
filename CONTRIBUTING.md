# Contributing

Thanks for taking the time to improve `dsh-queue-withdraw`.

## Ground rules

- **No build step and no runtime dependencies.**
- **Use public Session APIs.** Remove the queue item through
  `Session.updateQueue(itemId, { kind: 'remove' })`; do not mutate queue projections.
- **Never silently drop attachments.** Messages with non-text blocks stay queued.
- **Theme tokens only.** Use `--dsw-*` variables; never hard-code colors.
- **Keep the Host in charge.** The plugin decorates rendered queue rows; QueueDock and the queue
  projection remain the source of truth.

## Verification

```sh
node scripts/check.mjs
```

CI runs the same command on every push and pull request.

## Documentation and commits

Keep `README.md` (Simplified Chinese, primary) and `README.en.md` in sync, and record user-visible
changes in `CHANGELOG.md`. Use Conventional Commits, e.g.:

```
feat: add withdraw-to-input action for queued messages
```
