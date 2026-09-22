import { describe, expect, it } from 'vitest';
import { signedIn } from './caller.ts';

/**
 * A token of the shape the gateway hands a function, left unsigned: signedIn
 * only reads claims, because the signature is already proven by the time it
 * runs.
 */
function token(claims: Record<string, unknown>): string {
	const part = (o: unknown) =>
		Buffer.from(JSON.stringify(o))
			.toString('base64')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
	return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}.signature`;
}

const asking = (auth?: string) =>
	new Request('https://example.test/route', {
		method: 'POST',
		headers: auth ? { Authorization: auth } : {}
	});

const hour = Math.floor(Date.now() / 1000) + 3600;

describe('who may spend the routing budget', () => {
	it('lets a signed-in traveller through', () => {
		expect(signedIn(asking(`Bearer ${token({ role: 'authenticated', exp: hour })}`))).toBe(true);
	});

	it('turns away the publishable key, which ships in the browser', () => {
		expect(signedIn(asking(`Bearer ${token({ role: 'anon', exp: hour })}`))).toBe(false);
	});

	it('turns away a publishable key that is not a JWT at all', () => {
		expect(signedIn(asking('Bearer sb_publishable_abc123'))).toBe(false);
	});

	it('turns away an expired token', () => {
		expect(signedIn(asking(`Bearer ${token({ role: 'authenticated', exp: hour - 7200 })}`))).toBe(
			false
		);
	});

	it('turns away a token with no role', () => {
		expect(signedIn(asking(`Bearer ${token({ exp: hour })}`))).toBe(false);
	});

	it('turns away a caller with no token', () => {
		expect(signedIn(asking())).toBe(false);
	});

	it('turns away rubbish', () => {
		expect(signedIn(asking('Bearer ...'))).toBe(false);
		expect(signedIn(asking('Bearer a.!!!.c'))).toBe(false);
	});
});
