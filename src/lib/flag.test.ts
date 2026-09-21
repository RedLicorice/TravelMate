import { describe, it, expect } from 'vitest';
import { flagEmoji, flagLabel } from './flag';

describe('flagEmoji', () => {
	it('maps a country code to its flag', () => {
		expect(flagEmoji('GB')).toBe('🇬🇧');
		expect(flagEmoji('IT')).toBe('🇮🇹');
		expect(flagEmoji('JP')).toBe('🇯🇵');
	});

	it('does not care about case or stray spaces', () => {
		expect(flagEmoji(' gb ')).toBe('🇬🇧');
	});

	it('refuses anything that is not two letters', () => {
		expect(flagEmoji('GBR')).toBeNull();
		expect(flagEmoji('G1')).toBeNull();
		expect(flagEmoji('')).toBeNull();
		expect(flagEmoji(null)).toBeNull();
	});
});

describe('flagLabel', () => {
	it('prefers the flag', () => {
		expect(flagLabel('IT', 'Rome')).toBe('🇮🇹');
	});

	it('falls back to the city, so a trip with no country still reads as something', () => {
		expect(flagLabel(null, 'Rome')).toBe('RO');
	});
});
