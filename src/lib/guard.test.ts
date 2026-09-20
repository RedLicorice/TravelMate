import { describe, it, expect } from 'vitest';
import { redirectTarget } from './guard';

describe('redirectTarget', () => {
	it('sends a signed-out visitor to login', () => {
		expect(redirectTarget('/', false)).toBe('/login');
	});

	it('leaves a signed-out visitor on login alone', () => {
		expect(redirectTarget('/login', false)).toBeNull();
	});

	it('sends a signed-in visitor away from login', () => {
		expect(redirectTarget('/login', true)).toBe('/');
	});

	it('leaves a signed-in visitor where they are', () => {
		expect(redirectTarget('/trip/new', true)).toBeNull();
	});

	it('lets anyone reach a shared plan', () => {
		expect(redirectTarget('/shared/abc', false)).toBeNull();
		expect(redirectTarget('/shared/abc', true)).toBeNull();
	});

	it('ignores a base path prefix when matching routes', () => {
		// Under GitHub Pages every path carries '/TravelMate'. A guard that
		// matches on the raw pathname would bounce a signed-in user forever.
		expect(redirectTarget('/TravelMate/login', true, '/TravelMate')).toBe('/');
		expect(redirectTarget('/TravelMate/shared/abc', false, '/TravelMate')).toBeNull();
		expect(redirectTarget('/TravelMate/', false, '/TravelMate')).toBe('/login');
	});
});
