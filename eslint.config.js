import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      // DB-Ergebnisse (`const [row] = await sql...`) sind nach Prüfung sicher – Assertion ist hier lesbarer.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Geldbeträge nie als Fließkomma parsen.
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Beträge über money.ts parsen (Cent, bigint).' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Number', property: 'parseFloat', message: 'Beträge über money.ts parsen (Cent, bigint).' },
      ],
    },
  },
  {
    files: ['e2e/**/*.mjs', 'scripts/**/*.mjs'],
    // Browser-Tests: Node + Code, der in page.evaluate im Browser läuft; Zahlen nur für Anzeige-Vergleiche
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        document: 'readonly',
        location: 'readonly',
        FormData: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: { 'no-restricted-globals': 'off' },
  },
);
