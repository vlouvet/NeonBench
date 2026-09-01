import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// Tier 3 #105 — ban the raw numeric input.
//
// `<input type="number">` with a numeric `step` makes `min` the base of a
// lattice of valid values. A value off that lattice fails HTML constraint
// validation, and inside a `<form>` that silently swallows the submit: no
// exception, no console warning, no state change, just a button that does
// nothing. It shipped in PR #146 and again in PR #158, weeks apart, with the
// hazard already written into CLAUDE.md as prose. Prose did not work, so it
// is a lint error now.
//
// `web/src/components/NumericField.tsx` is the sanctioned wrapper: it
// defaults to `step="any"` and offers `integer` for genuine counters.
//
// NOTE ON THE SELECTOR: it matches the literal attribute `type="number"`.
// A computed type (`type={someVar}`) slips past it, as does a hand-rolled
// `React.createElement('input', { type: 'number' })`. Neither pattern exists
// in this repo, and a selector that tried to catch them would be guesswork;
// the rule is a tripwire on the shape people actually write, not a proof.
export const NUMERIC_INPUT_RULE = {
  selector:
    "JSXOpeningElement[name.name='input'] > JSXAttribute[name.name='type'][value.value='number']",
  message:
    'Raw <input type="number"> is banned (todo.md row 105). A numeric `step` makes `min` a lattice base, ' +
    'and an off-lattice value silently swallows the form submit — it shipped that way twice (PR #146, PR #158). ' +
    'Use <NumericField> from src/components/NumericField.tsx: it defaults to step="any", and takes `integer` ' +
    'when the quantity really is a discrete counter.',
}

// Files where the raw element is tolerated. Kept as a named export so the
// test suite can assert the list has not quietly grown.
//
//   * NumericField.tsx is the wrapper itself — the one place the raw element
//     legitimately appears, since it is what the rule points everyone at.
//
//   * EditorPage.tsx and ArrangePanel.tsx are a ROW 105 FOLLOW-UP. They still
//     hold 8 raw numeric inputs between them (EditorPage 4, ArrangePanel 4).
//     They are the repo's two highest-traffic frontend files (see the
//     file-coupling map in CLAUDE.md) and were being rewritten on a parallel
//     branch while row 105 landed, so migrating them was deliberately left
//     out of this PR's file scope rather than fought over in a merge.
//
// The rule stays `error` everywhere else. It is NOT downgraded to a warning
// anywhere — a warning is precisely how the prose version of this rule
// failed. Delete the two page entries together with the follow-up that
// migrates those 8 call sites to <NumericField>.
export const NUMERIC_INPUT_EXEMPT_FILES = [
  'src/components/NumericField.tsx',
  'src/pages/EditorPage.tsx',
  'src/components/ArrangePanel.tsx',
]

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      'no-restricted-syntax': ['error', NUMERIC_INPUT_RULE],
    },
  },
  {
    files: NUMERIC_INPUT_EXEMPT_FILES,
    rules: {
      // `'off'`, not `['error']` with an empty selector list: ESLint treats a
      // severity-only rule entry as "keep the inherited options", so
      // `['error']` would have left the ban fully in force here. That is not
      // a hypothetical — it is what this override did on the first attempt,
      // and `--print-config` was what caught it.
      'no-restricted-syntax': 'off',
    },
  },
])
