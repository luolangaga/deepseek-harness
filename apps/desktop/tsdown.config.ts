import { defineConfig } from 'tsdown'

/**
 * The desktop main process ships one bundled entry. The preload and the
 * renderer transport shim are Electron-shaped artifacts the tsdown pipeline
 * does not emit, so they build through the esbuild step in build/assets.mjs.
 * Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/main.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // electron is a devDependency, so the dependency-based auto-externalizer
  // would inline its CJS path stub (__dirname under ESM) into the bundle.
  external: ['electron'],
})
