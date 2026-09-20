import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

// CI sets this to '/<repo>' so assets resolve under the GitHub Pages subpath.
const base = process.env.BASE_PATH ?? '';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// Pure SPA: auth state lives only in the browser, so there is nothing
			// meaningful to render on a server that will never exist.
			adapter: adapter({ fallback: '404.html' }),
			paths: { base }
		})
	],
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts']
	}
});
