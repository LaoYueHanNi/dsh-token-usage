/**
 * One-shot initialization marker: whether the plugin ever completed a history
 * sync. The marker exists only to gate the FIRST automatic sync; every later
 * sync is the user's decision (the manual command).
 *
 * @module token-usage/sync-state
 */
/** Contents of the initialized marker. */
export interface SyncState {
    /** Epoch milliseconds when the first automatic sync completed. */
    initializedAt: number;
}
/**
 * Whether the first automatic sync already completed. A missing or malformed
 * marker reads as uninitialized: the next startup re-runs the sync, whose
 * dedupe makes the repetition a no-op.
 * @param dir - the data directory holding the marker.
 */
export declare function isInitialized(dir: string): Promise<boolean>;
/**
 * Persist the initialized marker atomically (temp file + rename), so a crash
 * mid-write never leaves a torn marker that would misread as initialized.
 * @param dir - the data directory holding the marker.
 * @param now - clock source (test seam).
 */
export declare function markInitialized(dir: string, now?: () => Date): Promise<void>;
//# sourceMappingURL=sync-state.d.ts.map