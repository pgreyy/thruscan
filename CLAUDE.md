## Testing rules
- Match checks to the size of the change. Small change: run the build once, plus at most one quick check of the exact behavior that changed.
- Do not run full test suites, browser or screenshot loops, viewport/theme/wallet matrices, or a local debug server unless I ask for them.
- Real-transaction runs only when the change touches signing, keys or money. Even then, 2 or 3 targeted checks, not a full pass.
- Never re-run a check that already passed in this session.
- If a check hangs or takes longer than 3 minutes, stop it, say what you did not verify, and move on.
- Finish with: what changed, the merge hash, the undo command, and a plain list of anything unverified.
