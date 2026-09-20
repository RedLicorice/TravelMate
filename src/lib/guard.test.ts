import { describe, it, expect } from 'vitest';
import { redirectTarget, safeNext } from './guard';

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

describe('safeNext', () => {
	it('accepts an ordinary same-origin path', () => {
		expect(safeNext('/shared/abc-123')).toBe('/shared/abc-123');
		expect(safeNext('/trip/1/add')).toBe('/trip/1/add');
	});

	it('rejects an absolute URL', () => {
		// Otherwise a link to our own domain lands someone on another one,
		// with the address bar they started from still in their head.
		expect(safeNext('https://evil.example/steal')).toBeNull();
		expect(safeNext('http://evil.example')).toBeNull();
	});

	it('rejects protocol-relative forms', () => {
		expect(safeNext('//evil.example')).toBeNull();
		expect(safeNext('/\\evil.example')).toBeNull();
	});

	it('rejects a scheme smuggled mid-string', () => {
		expect(safeNext('/x?u=javascript://evil')).toBeNull();
	});

	it('rejects anything not rooted at /', () => {
		expect(safeNext('trip/1')).toBeNull();
		expect(safeNext('../admin')).toBeNull();
	});

	it('treats absent and blank as no destination', () => {
		expect(safeNext(null)).toBeNull();
		expect(safeNext(undefined)).toBeNull();
		expect(safeNext('   ')).toBeNull();
	});
});

describe('reset route', () => {
	it('is reachable before a session exists', () => {
		// The recovery token in the URL is what creates the session; bouncing to
		// /login first would discard it.
		expect(redirectTarget('/reset', false)).toBeNull();
		expect(redirectTarget('/TravelMate/reset', false, '/TravelMate')).toBeNull();
	});
});
