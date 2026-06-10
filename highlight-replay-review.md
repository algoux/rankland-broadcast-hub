# Highlight-Replay Implementation Review

**Date:** 2026-05-29
**Reviewer:** Claude Code (code-review, extra-high effort / recall mode)
**Scope:** `clips` module implementation vs. `docs/v1/designs/highlight-replay.md` and `docs/v1/protocols/highlight-replay.md`

## Files reviewed

| Layer | File |
|---|---|
| Types/DTO | `src/common/modules/clips/{clip.types.ts, clip.dto.ts, index.ts}` |
| Config | `src/server/configs/clips/clip.config.ts` |
| Service | `src/server/modules/clips/clip.service.ts` |
| Repository | `src/server/modules/clips/clip.repository.ts` |
| Controller | `src/server/modules/clips/clip.controller.ts` |
| Range util | `src/server/modules/clips/range.util.ts` |
| Socket.io | `src/server/modules/socket-io/socket-io.ts` (clips namespace + dispatch) |
| Err codes | `src/common/enums/err-code.enum.ts`, `src/server/err-code-configs/general.err-code.ts` |
| Tests | `tests/clips/*.spec.ts`, `tests/fixtures/live-contest-service.ts` |

## Verdict

The implementation is a faithful and fairly complete realization of the v1 protocol: all HTTP routes, DTOs, the TUS-style upload flow, HTTP Range reads, the SQLite schema (with `uca` on every table), the automation/run/task/upload/clip data model, the `/clips` Socket.io namespace, broadcaster dispatch with ack timeout + retry, and the `300xxx` error codes are all present and match the docs. `pnpm run test:clips` passes (10/10), covering the happy path, idempotency, checksum mismatch, resumable offset, and soft-delete.

However, there are several **real correctness and security defects**, the two most important being an **unauthenticated progress endpoint that lets a caller force arbitrary task status**, and a **duplicate-`complete` path that corrupts the first clip's media file**. Details below, ranked most severe first.

---

## Findings

### 1. [High] `POST /api/clips/tasks/:taskId/progress` is unauthenticated and accepts an unvalidated `status`

- **Where:** `clip.controller.ts:130-135` (no `@UseGuards(AuthGuard)`, no upload-token check), `clip.dto.ts:310-313` (`status` is only `@IsOptional() @IsString()` — no `@IsIn`), `clip.service.ts:263-271` (task-level branch writes `status` straight through with no state-machine guard and **no `recalculateTask`**).
- **Spec:** The protocol's default header rule (`docs/.../highlight-replay.md` line 11-14) says every management endpoint requires `X-UCA` + `X-Token`. The upload endpoints intentionally swap that for `X-Upload-Token`; the progress endpoint has **neither**. `ApiController` only adds the `/api` prefix (`src/server/decorators/index.ts:12`), so there is no implicit guard.
- **Failure scenario:** Any client that knows a `taskId` and the contest `uca` (no token at all) can `POST .../progress` with `{ "progress": 100, "status": "ready" }`. The service writes `status='ready'` directly to the task and emits `clipTaskUpdated` to all KtO subscribers — a task is now reported "ready" with zero produced clips. The same path can force `failed`/`expired`/`cancelled`, or regress a real `ready` item via the `itemId` branch.
- **Fix:** Add `@UseGuards(AuthGuard)` (or bind it to the item's upload token like the other KtB calls), constrain `status` with `@IsIn(...)`, and validate transitions server-side rather than trusting the client value.

### 2. [High] Duplicate `completeUpload` corrupts the first clip and creates a duplicate

- **Where:** `clip.service.ts:472-553`; `getAuthorizedUpload` (`:692-704`) does **not** reject an upload whose `status === 'completed'`, and the media branch has no "already completed" short-circuit (unlike `appendUploadStream`, which does at `:439-441`).
- **Failure scenario:** Client calls `complete`, gets a network timeout on the response, and retries (the upload token TTL is 15 min, so it's still valid). On the second call: `upload.offset === uploadLength` still holds; `absPath` now resolves to the *first* clip's `clips/{clipId1}/media.{ext}` (because the first call did `updateUpload(..., storagePath: mediaPath)` at `:539`); `sha256File` + `validateMedia` pass; then `fs.renameSync(absPath, clips/{clipId2}/media.ext)` at `:506` **moves clip1's media file away**. Result: `clipId1` row now points at a missing file (its media endpoints will `fs.statSync` → throw), and a duplicate `clipId2` clip is created, with `item.clipId` overwritten to `clipId2`.
- **Fix:** At the top of `completeUpload`, if `upload.status === 'completed'`, return the existing task/clip idempotently instead of re-running the rename/create.

### 3. [Med-High] Resume after a mid-`PATCH` error duplicates bytes; the upload can then never complete

- **Where:** `clip.service.ts:442-468`. The file is opened with `fs.createWriteStream(absPath, { flags: 'a' })` (blind append), and on the overflow guard (`:449-451`) or any stream error the `catch` does `output.destroy()` and rethrows **without truncating the bytes already written** and **without persisting a new offset** (`updateUpload` at `:464` is only reached on success).
- **Failure scenario:** A chunk write partially flushes to disk and then the loop throws (overflow, or a transient write/stream error). The on-disk `.part` file is now longer than the DB `offset`. The client resumes by sending the DB `offset` (which still matches `upload.offset`), `flags:'a'` appends *after* the already-written tail, and the file ends up longer than `uploadLength` with a duplicated region → the final `sha256File` never matches `checksumSha256`, so `complete` permanently fails with `ClipUploadChecksumMismatch`.
- **Fix:** Write at the known-good position instead of appending blindly — e.g. open with `flags: 'r+'` and `fs.createWriteStream(absPath, { flags: 'r+', start: upload.offset })`, or `fs.truncateSync(absPath, upload.offset)` before appending. (Also consider mapping the overflow throw to a clip-specific code rather than `IllegalParameters`.)

### 4. [Med] Uploaded thumbnail content is never checksum-verified

- **Where:** `clip.service.ts:482-485` (thumbnail-role `complete` marks the upload completed and returns, with no hashing) and `consumeThumbnailUpload` (`:741-747`) only compares `upload.checksumSha256` (stored from the `createUpload` request) against `thumbnail.checksumSha256` (the `complete` metadata) — **both are client-supplied**, neither is computed from the bytes on disk.
- **Spec:** Design doc line 30 / 40 require Hub to validate uploaded size and checksum.
- **Failure scenario:** A thumbnail whose bytes don't match its declared checksum is accepted and served as-is; a corrupted/truncated thumbnail passes validation.
- **Fix:** Run `sha256File` on the thumbnail `.part` (and verify byte size) in the thumbnail-role `complete` branch, same as media.

### 5. [Med] No per-upload lock — concurrent `PATCH` chunks can interleave and corrupt the file

- **Where:** `clip.service.ts:428-470`. Two concurrent `PATCH`es that both read the same `offset` both pass the `uploadOffset !== upload.offset` check and both `createWriteStream(flags:'a')`, interleaving writes.
- **Failure scenario:** A client (or a retry racing the original) issues two appends at the same offset; the file is corrupted and the final checksum fails. *(PLAUSIBLE — depends on the client issuing concurrent chunks; well-behaved TUS clients are sequential.)*
- **Fix:** Serialize appends per `uploadId` (in-process mutex/queue), and/or validate that `fs.statSync(absPath).size === upload.offset` before writing.

### 6. [Med] Creating a thumbnail upload clobbers the item's media linkage

- **Where:** `clip.service.ts:399-404`. `createUpload` unconditionally runs `updateTaskItem(itemId, { uploadId, status: 'uploading', progress: 0 })` regardless of `role`.
- **Failure scenario:** Media upload is created (item.uploadId → mediaUpload, status `uploading`), then a thumbnail upload is created for the same item → `item.uploadId` is overwritten to the thumbnail upload and progress reset. Functionally the media `complete` still works (it reads `upload.itemId`, not `item.uploadId`), but the item's recorded `uploadId`/status is now wrong, and `recalculateTask` may flip the task back to a stale state.
- **Fix:** Only mutate `item.uploadId`/status for `role === 'media'` (or track media/thumbnail upload ids separately).

### 7. [Med] Spec-mandated resource limits are only partially enforced

- **Where:** `clip.service.ts:621-640` (`validateTaskRequest`) and `:663-678` (`validateUploadRequest`).
- **Spec:** Security section (design line 310) — "Hub 必须限制单文件大小、单任务 track 数量、切片最大时长和总存储配额."
- **Gap:** Single-file size (`maxUploadBytes`) and max duration (`maxDurationMs`) are enforced, but **per-task `trackIds` count is unbounded** and there is **no total storage quota**. A task with thousands of `trackIds` is accepted (each spawns an item + dispatch), and storage can grow without limit.
- **Fix:** Add a max-tracks-per-task config check and a storage-quota guard (or document these as deferred).

### 8. [Low-Med] Clip media/metadata is readable across contests (UCA optional)

- **Where:** `clip.controller.ts:185-233` use `getOptionalUca()` (`:250-252`); `clip.repository.ts:543-548` omits the `uca` filter when `uca` is undefined.
- **Failure scenario:** `GET /api/clips/:clipId/media` without an `X-UCA` header returns any clip's media by id, ignoring contest isolation. Mostly moot today because all directors share one global `AUTH_TOKEN`, but it diverges from the spec's per-`uca` isolation intent and becomes a real leak if per-contest tokens are ever introduced. Note also `GET /api/clips/:clipId` is not in the protocol spec at all.
- **Fix:** Require `X-UCA` and always scope clip lookups by `uca` for the consume endpoints.

### 9. [Low] Soft-delete/expiry are not actually cleaned up

- **Where:** `clip.service.ts:607-614` (`deleteClip` only flips `status='deleted'`); no expiry job anywhere; `expiresAt` is stored but never acted on.
- **Spec:** "保留与清理" section — soft-deleted media should enter an async cleanup queue, and `expired` clips should be reaped after retention.
- **Impact:** Media files for deleted/expired clips accumulate forever; `status='expired'` is never set. (Acceptable as a v1 deferral, but worth flagging against the spec.)

### 10. [Low] Redundant offset double-check + inconsistent error shape on raw `PATCH`

- **Where:** `clip.controller.ts:151-169` pre-checks the offset and returns `409` with headers, then `clip.service.ts:436-438` re-checks and throws `ClipUploadOffsetMismatch`.
- **Impact:** Dead/duplicated logic; and if the inner throw ever fires (race between the two reads), a `LogicException` is rendered as `Resp` JSON on an endpoint the spec says is *not* JSON-wrapped, breaking the documented `409 Conflict` + `Upload-Offset` contract. Pick one place to enforce the offset.

### 11. [Low] `markTaskDispatchFailed` resets already-cancelled items

- **Where:** `clip.service.ts:335-344` filters only `item.status !== 'ready'`, so a `cancelled` item is reset to `failed`/`queued` on a dispatch failure.
- **Fix:** Also exclude `cancelled` (mirror the filter used in `beginTaskDispatch` at `:283`).

### 12. [Low] `verifying` status is defined but never reached

- **Where:** State machine in `clip.types.ts:7-27` / docs include `verifying`, but validation in `completeUpload` is synchronous and `recalculateTask` (`:755-784`) never produces `verifying`. Cosmetic divergence from the documented status set.

### 13. [Low] Unsupported multi-range returns `416` instead of `200`

- **Where:** `range.util.ts:14` — the regex only matches a single `bytes=a-b`, so `bytes=0-1,2-3` falls through to `unsatisfiable` → `416`.
- **Impact:** RFC 9110 allows a server that doesn't support multipart ranges to ignore the header and return `200` with the full body; returning `416` for a syntactically valid (if unsupported) multi-range is stricter than ideal. Spec only requires single-range support, so low priority.

---

## Spec-compliance summary

**Implemented & matching the protocol:** all automation/run/task/upload/clip routes; DTO shapes & enums; TUS create/HEAD/PATCH/complete with `Upload-Offset`/`Upload-Length`/`Upload-Expires`; Range reads with `206`/`416`/`Accept-Ranges`/`ETag`; idempotency (`idempotencyKey`, `triggerKey`); per-`uca` SQLite schema + indexes; path-traversal guard (`getAbsolutePath`); `/clips` namespace with `subscribeClips` filtering on `clipCreated`; broadcaster `requestCreateClip` dispatch with ack timeout, retry accounting, and retryable/non-retryable error classification; the full `300xxx` error-code block. Container magic-byte checks (`ftyp` / EBML) are a nice touch beyond the minimum.

**Notable gaps vs. spec:** unauthenticated progress endpoint (#1); thumbnail checksum not verified (#4); per-task track-count + storage-quota limits missing (#7); cross-contest read via optional UCA (#8); cleanup queue / expiry enforcement absent (#9); `verifying` status unused (#12). `clipTaskUpdated`/`clipDeleted` are broadcast to the whole room without applying per-socket subscription filters — consistent with the spec (which only filters `clipCreated`-style consumption), so noted but not a defect.

## Recommendation

Address #1 and #2 before any real deployment (auth bypass + data corruption), then #3–#6 (upload robustness/integrity). #7–#13 can be scheduled or explicitly deferred. Add integration tests for: duplicate `complete`, resume-after-error, thumbnail checksum, and an unauthenticated progress call.

---

# Re-review (after fixes) — 2026-05-29

The agent applied fixes to `clip.service.ts`, `clip.controller.ts`, `clip.dto.ts`, `clip.config.ts`, `range.util.ts`, and added tests. `socket-io.ts` was unchanged (none of the socket-side notes required code changes).

**Verification performed:** re-read every changed file; `pnpm run test:clips` → **19/19 pass** (was 10); `npx tsc --noEmit -p src/server/tsconfig.json` → **0 errors**.

## Status of each original finding

| # | Finding | Status | Evidence |
|---|---|---|---|
| 1 | Unauthenticated progress + unvalidated status | ✅ **Fixed** | `@UseGuards(AuthGuard)` on `reportTaskProgress` (`clip.controller.ts:131`); DTO `status` now `@IsIn(...)` (`clip.dto.ts:311`); service `validateProgressStatus` rejects `ready`/`partial_ready`/`expired`/`queued`/`verifying` (`clip.service.ts:252,694-704`). Test: "rejects progress updates that attempt to mark tasks ready" (`:352`). |
| 2 | Duplicate `complete` corrupts first clip | ✅ **Fixed** | Early idempotent return when `upload.status === 'completed'` via `getCompletedUploadResult` (`clip.service.ts:493-495,747-761`). Test: "returns the existing clip when media completion is retried" (`:187`) asserts same `clipId`, 1 clip total, media file intact. |
| 3 | Resume after mid-PATCH error duplicates bytes | ✅ **Fixed** | Now opens `flags:'r+', start: upload.offset`, `truncateSync(absPath, upload.offset)` before write and again in `catch` (`clip.service.ts:452-453,470`). Test: "truncates stale upload tails before resuming" (`:212`) appends a stale tail then asserts the resumed file equals the original media. |
| 4 | Thumbnail bytes never checksum-verified | ✅ **Fixed** | New `verifyUploadChecksum` (size + sha256) called for thumbnail and media branches (`clip.service.ts:497,503,732-745`). Test: "verifies thumbnail bytes before marking thumbnail uploads complete" (`:280`). |
| 5 | No per-upload lock (concurrent PATCH) | ✅ **Fixed** | `appendUploadStream` wrapped in `withUploadLock(uploadId, …)` (`clip.service.ts:441,877-896`). Lock impl traced and correct: serializes per `uploadId`, releases in `finally`, self-cleans the map entry. |
| 6 | Thumbnail upload clobbers item media linkage | ✅ **Fixed** | Item `uploadId`/status only mutated for `role === 'media'` (`clip.service.ts:403-412`). Test: "does not overwrite the media upload id when creating thumbnail uploads" (`:316`). |
| 7 | Missing track-count / storage-quota limits | ✅ **Fixed** | `maxTracksPerTask` check (`clip.service.ts:636-638`) + `assertStorageQuota` (`:377,868-875`); config `maxTracksPerTask` (8) and `maxStorageBytes` (20 GiB) added (`clip.config.ts:10-11`). Test: "limits track count per task" (`:398`). See N1 below. |
| 8 | Cross-contest clip read (optional UCA) | ✅ **Fixed** | `getOptionalUca` removed; all consume endpoints use required `getUca()` (`clip.controller.ts:201,207,218,229`); `getStoredClip` throws on missing `uca` (`clip.service.ts:843-846`). Test: "requires uca when reading clips" (`:390`). |
| 9 | No async cleanup / retention enforcement | ⚠️ **Deferred** | `deleteClip` still only flips status; no expiry reaper. Was flagged low; acceptable as a documented v1 gap. |
| 10 | Redundant offset check + bad error shape on PATCH | ✅ **Fixed** | PATCH now catches `ClipUploadOffsetMismatch` and returns a proper `409` + `Upload-Offset` instead of leaking a JSON `Resp` (`clip.controller.ts:161-178`). |
| 11 | `markTaskDispatchFailed` resets cancelled items | ✅ **Fixed** | Filter now excludes `cancelled` (`clip.service.ts:339`). Test: "keeps cancelled items cancelled when a dispatch retry fails" (`:373`). |
| 12 | `verifying` status never reached | ⚠️ **Deferred** | Still not produced (validation is synchronous). Cosmetic vs. the documented state set. |
| 13 | Multi-range returns 416 instead of 200 | ✅ **Fixed** | Comma-containing ranges now return `full` (200) (`range.util.ts:14-16`). New range test added (5 total). |

**Net: 11 of 13 fixed (all High/Med), 2 low/cosmetic deferred.** No fix introduced a regression (typecheck + full suite green), and the fixes are layered sensibly (DTO enum + service transition guard + route guard for #1; rename-as-mutex + idempotent return for #2).

## New observations introduced by the fixes (both low)

### N1. [Low] Storage-quota check does a full synchronous tree walk on every upload create, and counts the SQLite DB

- **Where:** `clip.service.ts:868-875` (`assertStorageQuota`) → `getDirectorySize` (`:927-938`), called from `createUpload` (`:377`).
- **Cost:** `getDirectorySize(this.config.storageDir)` recursively `readdirSync`/`statSync`s the entire storage tree on *every* `createUpload`. That is O(total files) blocking I/O per upload session, and because `sqlitePath` defaults to `{storageDir}/clips.sqlite` the DB + `-wal`/`-shm` files are counted toward the quota (slight over-count). Two concurrent creates can also both pass the check (soft TOCTOU). Fine at v1 volumes; consider a maintained running total or excluding the DB if libraries grow large.

### N2. [Low] `completeUpload` itself is not under `withUploadLock`

- **Where:** `clip.service.ts:483-564` — the new lock guards `appendUploadStream` but not `completeUpload`.
- **Impact:** The common **sequential** retry is fully fixed (idempotent early-return + test). For a **truly concurrent** double-`complete`, the `fs.renameSync(.part → clip/media)` acts as a natural mutex, so there is no duplicate clip or corruption — but the losing request hits `verifyUploadChecksum`/`rename` on an already-moved `.part` and throws a raw `ENOENT` (surfacing as a 500) rather than returning idempotently. Low likelihood; if desired, wrap `completeUpload` in the same per-upload lock for a clean idempotent response.

## Re-review verdict

The fixes are correct, well-targeted, and backed by focused tests; the two previously-critical issues (auth bypass and media-file corruption on retry) are resolved and proven by tests. Remaining items are the two low/cosmetic deferrals (#9 cleanup/expiry, #12 `verifying`) plus two new low-severity polish notes (N1, N2). **No blocker remains.**
