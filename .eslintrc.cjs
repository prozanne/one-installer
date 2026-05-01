module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { sourceType: 'module', ecmaVersion: 2022 },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true },
  ignorePatterns: ['node_modules', 'dist', 'coverage', 'test/fixtures/payloads'],
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        // `for (const _ of …)` / `const _ = …` placeholder convention.
        destructuredArrayIgnorePattern: '^_',
      },
    ],
    '@typescript-eslint/consistent-type-imports': 'error',
    '@typescript-eslint/no-explicit-any': 'error',
  },
  overrides: [
    {
      // Test helper files sometimes need require() for dynamic loading and
      // intentionally hold unused imports for parity with the real modules
      // they shim. Loosen these specifically rather than codebase-wide.
      files: ['test/**/*.ts', 'test/**/*.tsx'],
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
        '@typescript-eslint/consistent-type-imports': 'warn',
      },
    },
  ],
};
