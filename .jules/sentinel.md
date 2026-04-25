## 2026-04-25 - Prevent players from updating global game state (marked tracks)
**Vulnerability:** Broken access control allowed any player to mark tracks as played.
**Learning:** Firestore rules must specifically exclude fields that only hosts/admins should modify (e.g., `markedIds`) from the `affectedKeys().hasOnly()` list for non-host updates.
**Prevention:** Apply principle of least privilege in Firestore rules by scoping `affectedKeys()` to only fields the user owns or requires access to.
