/**
 * Who runs this app, as the Terms and the Privacy notice name them.
 *
 * PLACEHOLDERS. The operator below is invented -- the address is an example
 * street and the domain is `.example`, which can never be anybody's -- so
 * that the notices read complete. Replace every value here with the real
 * operator's before the app is offered to anyone, and have both notices
 * checked by someone qualified: they are drafts, not legal advice.
 */
export const OPERATOR = {
	name: 'TravelMate Demo Operator',
	address: "Via dell'Esempio 1, 00100 Roma (RM), Italia",
	vatId: 'IT00000000000',
	email: 'privacy@travelmate.example',
	/** The law the Terms are governed by, and whose courts hear disputes. */
	law: 'Italian law',
	courts: 'the courts of Rome, Italy, without prejudice to any mandatory consumer protection'
} as const;

/** Where the data is kept: Supabase's region for this project. */
export const DATA_REGION = 'the European Union (Ireland, AWS eu-west-1)';

/** How long diagnostics are kept, in days. The database deletes older ones (0062). */
export const DIAGNOSTICS_DAYS = 15;

/**
 * The version of the notices a choice was made against. Raise it when what
 * is collected changes, and everybody is asked again.
 */
export const NOTICE_VERSION = 1;

/** When the notices last changed, as they say at the top. */
export const NOTICES_DATED = '24 September 2026';
