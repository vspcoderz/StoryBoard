/**
 * ESM resolve hook: let extensionless relative imports resolve to `.ts`.
 *
 * The engine source uses bundler-style imports (`./geometry`) because that is what Next's resolver
 * expects and what every other file in the repo does. Node's native ESM resolver, by contrast,
 * requires a real path. Rewriting the source to `./geometry.ts` would mean either setting
 * `allowImportingTsExtensions` — which is a TS-config smell that leaks build concerns into source —
 * or renaming every import to a style the rest of the project does not use.
 *
 * So we teach the test runner one extra rule instead. This is a test-only shim: it never ships, and
 * it costs a dev dependency nothing.
 */

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
    const alreadyHasExtension = /\.[cm]?[jt]sx?$/.test(specifier)
    if (isRelative && !alreadyHasExtension) {
      return nextResolve(`${specifier}.ts`, context)
    }
    throw err
  }
}
