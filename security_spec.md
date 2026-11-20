# UrduDub AI — Security Specification (Phase 0)

## 1. Data Invariants

1. Every `MovieProject` in `/movies/{movieId}` belongs to an authenticated, email-verified user (`ownerId == request.auth.uid`) and cannot be read, listed, updated, or deleted by any other user.
2. Every `MovieProject` must enforce `rightsConfirmed == true`, `sourceLang == 'tr'`, `targetLang == 'ur-PK'`, `durationSeconds <= 10800` (180 minutes), and valid format (`mp4`, `mov`, `mkv`).
3. Once a `MovieProject` reaches `status == 'completed'`, its status and fields are terminal-locked against modification (`existing().status != 'completed'`).
4. Every `CharacterProfile` in `/movies/{movieId}/characters/{characterId}` and `ProcessingLog` in `/movies/{movieId}/logs/{logId}` enforces parent-document ownership via `get(/databases/$(database)/documents/movies/$(movieId)).data.ownerId == request.auth.uid`.
5. `UserProfile` documents in `/users/{userId}` are strictly isolated to `request.auth.uid == userId` (`allow list: if false` prevents user enumeration).
6. Timestamps (`createdAt`, `updatedAt`) must equal `request.time`, and `id` / `ownerId` / `createdAt` are immutable after creation.

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Identity Spoofing on Movie Create**: `{ ownerId: "other_user_uid", ... }` -> Rejected (`data.ownerId == request.auth.uid`).
2. **Ghost Field / Shadow Write on Movie Update**: `{ status: "processing", isAdmin: true }` -> Rejected (`affectedKeys().hasOnly(...)`).
3. **Unverified Email Bypass**: `request.auth.token.email_verified == false` -> Rejected (`isVerifiedUser()`).
4. **Oversized Duration Poisoning**: `{ durationSeconds: 18000 }` (>180 min) -> Rejected (`data.durationSeconds <= 10800`).
5. **Path ID Poisoning**: Document ID `"../etc/passwd"` or 500-char string -> Rejected (`isValidId()`).
6. **Blanket User List Scraping**: `list /users` by any signed-in user -> Rejected (`allow list: if false`).
7. **Cross-Tenant Movie List Query**: `list /movies` without `where("ownerId", "==", uid)` -> Rejected (`resource.data.ownerId == request.auth.uid`).
8. **Orphaned Character Subcollection Write**: Create under `/movies/nonexistent/characters/c1` -> Rejected (`isMovieOwner(movieId)`).
9. **Terminal State Tampering**: Update `/movies/{movieId}` when `existing().status == 'completed'` -> Rejected (`existing().status != 'completed'`).
10. **Client Timestamp Forgery**: `{ createdAt: Timestamp("1999-01-01") }` -> Rejected (`incoming().createdAt == request.time`).
11. **Missing Legal Rights Confirmation**: `{ rightsConfirmed: false }` -> Rejected (`data.rightsConfirmed == true`).
12. **Processing Log Mutation**: `update /movies/{movieId}/logs/{logId}` -> Rejected (`allow update: if false`).
