import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import jsdoc from 'eslint-plugin-jsdoc';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    plugins: { jsdoc },
    rules: {
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'function', format: ['camelCase'] },
        { selector: 'variable', format: ['camelCase', 'UPPER_CASE'] },
        { selector: 'typeLike', format: ['PascalCase'] },
      ],
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            MethodDefinition: false,
            ArrowFunctionExpression: false,
          },
        },
      ],
    },
  },
  {
    // Plain-JS launcher script (see bin/everest.js): not covered by tseslint's recommended
    // config, which only targets `**/*.ts` and disables `no-undef` there because the TS compiler
    // already checks it - Node globals need to be declared explicitly here instead.
    files: ['bin/**/*.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
      },
    },
  },
  { ignores: ['dist/', 'node_modules/', 'test/fixtures/'] },
  prettierConfig,
);
