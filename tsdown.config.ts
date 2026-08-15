import { defineConfig, type UserConfig } from 'tsdown'

const PACKAGE_ID = '@jinplu/dsh-plugin-discussion-intent'

const hostExternal = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
]

function host(name: string, entry: string): UserConfig {
  return {
    entry: { [name]: entry },
    outDir: 'lib',
    format: ['esm'],
    fixedExtension: false,
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
    outputOptions: { codeSplitting: false },
    deps: { neverBundle: hostExternal },
  }
}

const client: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: ['cjs'],
  fixedExtension: false,
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  deps: { neverBundle: ['react', 'react/jsx-runtime'] },
  outputOptions: {
    codeSplitting: false,
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([
  host('index', 'src/index.ts'),
  host('invariant', 'src/invariant.ts'),
  host('contract', 'src/contract.ts'),
  host('capabilities', 'src/capabilities.ts'),
  client,
])
