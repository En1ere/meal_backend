import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
    { ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.local/**', 'contracts/openapi.json'] },
    { ...js.configs.recommended, files: ['**/*.js'], languageOptions: { globals: globals.node } },
    ...tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: ['**/*.ts'] })),
    {
        files: ['**/*.ts'],
        languageOptions: {
            globals: globals.node,
            parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
        },
        rules: { '@typescript-eslint/no-explicit-any': 'error', '@typescript-eslint/no-floating-promises': 'error' },
    },
];
