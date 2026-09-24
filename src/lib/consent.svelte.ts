import { NOTICE_VERSION } from './legal';

/**
 * Whether this person agreed to send diagnostics.
 *
 * Asked on the login screen, before anything else, and kept on the device --
 * there is no account yet to keep it in. Once signed in, the profile holds it
 * and the device follows the profile. A choice made against an older version
 * of the notices is no choice: it is asked again.
 */
type Choice = { version: number; telemetry: boolean };

const KEY = 'travelmate.consent';

function read(): Choice | null {
	try {
		const c = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Choice | null;
		return c?.version === NOTICE_VERSION ? c : null;
	} catch {
		return null;
	}
}

export const consent = $state<{ choice: Choice | null }>({
	choice: typeof localStorage === 'undefined' ? null : read()
});

export function choose(telemetry: boolean) {
	consent.choice = { version: NOTICE_VERSION, telemetry };
	try {
		localStorage.setItem(KEY, JSON.stringify(consent.choice));
	} catch {
		// Private browsing, or storage refused: the choice holds for this visit.
	}
}

/** Off unless yes. */
export const diagnosticsAllowed = () => consent.choice?.telemetry === true;
