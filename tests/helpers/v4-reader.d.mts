/**
 * dsh's released v4 reader (`restoreReleasedV4Artifact`), typed just enough for
 * the read-back test: it either restores the artifact or throws the validation
 * error that names the offending event.
 */
export function readV4(
  artifact: { header: Record<string, unknown>; events: readonly unknown[]; inheritedEventCount?: number },
  knownEventTypes: ReadonlySet<string>,
): Promise<unknown>
