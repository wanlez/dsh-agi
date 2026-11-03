import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
  deps: {
    neverBundle: ['@deepseek-ai/dsh-home-paths', '@dsh-agi/native-selection', 'koffi'],
    // The installable host has no workspace link to this package. Its pure
    // modules have to travel inside the host bundle. Declaration emit keeps the
    // import, because the voice package only exports types from those paths.
    alwaysBundle: [/^@dsh-agi\/voice(\/|$)/],
    dts: { alwaysBundle: [] },
  },
})
