import { describe, it, expect } from 'vitest';
import { branchesOf, nearestBranch, sameBrand } from './branches';
import type { Poi } from './types';

const poi = (name: string, lat: number, lng: number): Poi => ({
	name,
	label: '',
	lat,
	lng,
	category: 'fast_food',
	durationMin: 45,
	openingHours: null,
	website: null,
	phone: null,
	osmId: null
});

const km = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
	Math.hypot(a.lat - b.lat, a.lng - b.lng);

describe('sameBrand', () => {
	it('sees through spacing and case', () => {
		expect(sameBrand('MeatLiquor', 'Meat Liquor')).toBe(true);
		expect(sameBrand('PRET A MANGER', 'Pret a Manger')).toBe(true);
	});

	it('sees through a branch written in brackets', () => {
		expect(sameBrand('Pret A Manger', 'Pret A Manger (65 Notting Hill Gate)')).toBe(true);
	});

	it('does not confuse two different places', () => {
		expect(sameBrand('Tate Modern', 'Tate Britain')).toBe(false);
	});
});

describe('branchesOf', () => {
	const pret = poi('Pret A Manger', 51.51, -0.13);

	it('collects the other shops of the same name', () => {
		const found = branchesOf(pret, [
			pret,
			poi('Pret a Manger', 51.52, -0.14),
			poi('Pret A Manger (Soho)', 51.513, -0.135),
			poi('Tate Modern', 51.5076, -0.0994)
		]);
		expect(found).toHaveLength(3);
		expect(found[0]).toEqual({ lat: 51.51, lng: -0.13 });
	});

	it('says nothing for a place that is only itself', () => {
		expect(branchesOf(poi('Tate Modern', 51.5076, -0.0994), [poi('Tate Britain', 51.49, -0.13)]))
			.toEqual([]);
	});

	it('does not count the same shop twice', () => {
		const found = branchesOf(pret, [pret, pret, poi('Pret A Manger', 51.52, -0.14)]);
		expect(found).toHaveLength(2);
	});
});

describe('nearestBranch', () => {
	it('picks the one nearest where the day has you', () => {
		const chain = {
			lat: 51.51,
			lng: -0.13,
			branches: [
				{ lat: 51.51, lng: -0.13 },
				{ lat: 51.52, lng: -0.2 }
			]
		};
		expect(nearestBranch(chain, { lat: 51.52, lng: -0.199 }, km)).toEqual({
			lat: 51.52,
			lng: -0.2
		});
	});

	it('leaves a one-off place exactly where it is', () => {
		const one = { lat: 51.5076, lng: -0.0994 };
		expect(nearestBranch(one, { lat: 51.6, lng: -0.3 }, km)).toEqual(one);
	});
});
