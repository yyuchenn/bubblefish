import prettier from 'eslint-config-prettier';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import unusedImports from 'eslint-plugin-unused-imports';
import ts from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

export default ts.config(
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	prettier,
	...svelte.configs.prettier,
	{
		ignores: [
			'.svelte-kit/**/*',
			'build/**/*',
			'dist/**/*',
			'node_modules/**/*',
			'src/lib/wasm-pkg/**/*'
		]
	},
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node },
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser,
				svelteConfig
			}
		},
		rules: {
		"no-undef": 'off',
		"@typescript-eslint/no-unused-vars": [
			'error',
			{
				argsIgnorePattern: '^_',
				varsIgnorePattern: '^_',
				caughtErrorsIgnorePattern: '^_'
			}
		],
		"unused-imports/no-unused-imports": 'error',
		
		// Svelte specific rules
		// Possible Errors
		"svelte/no-reactive-reassign": 'error',
		"svelte/no-dom-manipulating": 'warn',
		"svelte/no-dupe-else-if-blocks": 'error',
		"svelte/no-object-in-text-mustaches": 'warn',
		"svelte/no-not-function-handler": 'error',
		"svelte/no-at-debug-tags": 'error',
		"svelte/valid-compile": 'error',
		
		// Security
		"svelte/no-at-html-tags": 'warn',
		"svelte/no-target-blank": 'error',
		
		// Best Practices
		"svelte/no-unused-props": 'warn',
		"svelte/require-each-key": 'error',
		"svelte/no-reactive-functions": 'warn',
		"svelte/no-reactive-literals": 'warn',
		"svelte/no-useless-mustaches": 'warn',
		"svelte/prefer-const": 'warn',
		"svelte/require-store-reactive-access": 'warn',
		"svelte/valid-prop-names-in-kit-pages": 'error',
		"svelte/no-store-async": 'error',
		"svelte/require-store-callbacks-use-set-param": 'error',
		
		// Stylistic (可选，根据团队偏好调整)
		"svelte/first-attribute-linebreak": ['warn', {
			multiline: 'below',
			singleline: 'beside'
		}],
		"svelte/html-quotes": ['warn', { prefer: 'double' }],
		"svelte/mustache-spacing": ['warn', {
			textExpressions: 'never',
			attributesAndProps: 'never',
			directiveExpressions: 'never',
			tags: {
				openingBrace: 'never',
				closingBrace: 'never'
			}
		}],
		"svelte/no-spaces-around-equal-signs-in-attribute": 'warn',
		"svelte/spaced-html-comment": ['warn', 'always']
		},
		plugins: {
			'svelte': svelte,
			'unused-imports': unusedImports
		},
		files: [
			'**/*.svelte',
			'**/*.svelte.ts',
			'**/*.svelte.js'
		]
	}
);
