// Dependency caps are intentional: Node/@types/node 24 baseline; TypeScript ~6.0
// stays below typescript-eslint's <6.1 peer ceiling (do not upgrade to TS 7 alone).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    ...js.configs.recommended,
    files: ['**/*.cjs', '**/*.mjs', '**/*.js'],
    languageOptions: { globals: globals.node },
  },
  ...tseslint.configs.recommended.map(config => ({ ...config, files: ['src/**/*.ts'] })),
  {
    files: ['src/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
];
