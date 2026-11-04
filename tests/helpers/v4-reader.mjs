// Runtime-only entry to dsh's released v4 reader.
//
// The package ships `.d.ts` files that do not typecheck under this project's
// `skipLibCheck: false`, so the read-back test reaches the reader through this
// thin module and a hand-written declaration instead of importing the package
// from TypeScript.
export async function readV4(artifact, knownEventTypes) {
  const { restoreReleasedV4Artifact } = await import('dsh-v4-format')
  return restoreReleasedV4Artifact(artifact, knownEventTypes)
}
