/**
 * Install state for the home-screen prompt.
 *
 * Two platforms, two behaviours. Chromium fires `beforeinstallprompt`, which
 * we hold onto and replay when the traveller taps Install. iOS Safari fires
 * nothing and has no API at all -- the only route is Share > Add to Home
 * Screen, so there we show instructions rather than a button that cannot work.
 */
type Choice = { outcome: 'accepted' | 'dismissed' };
type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<Choice> };

export const install = $state({
	/** Chromium handed us a prompt we can replay. */
	available: false,
	/** iOS: no API, so the UI has to explain the manual route. */
	manual: false,
	/** Already running from the home screen — offer nothing. */
	installed: false
});

let deferred: InstallEvent | null = null;

const isStandalone = () =>
	window.matchMedia('(display-mode: standalone)').matches ||
	// iOS marks a home-screen launch with a non-standard property.
	(navigator as unknown as { standalone?: boolean }).standalone === true;

const isIos = () =>
	/iphone|ipad|ipod/i.test(navigator.userAgent) ||
	// iPadOS 13+ reports as a Mac; the touch points give it away.
	(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function watchInstall(): () => void {
	install.installed = isStandalone();
	if (install.installed) return () => {};

	install.manual = isIos();

	const onPrompt = (e: Event) => {
		// Chromium shows its own mini-infobar unless this is cancelled.
		e.preventDefault();
		deferred = e as InstallEvent;
		install.available = true;
		install.manual = false;
	};
	const onInstalled = () => {
		install.installed = true;
		install.available = false;
		install.manual = false;
		deferred = null;
	};

	window.addEventListener('beforeinstallprompt', onPrompt);
	window.addEventListener('appinstalled', onInstalled);
	return () => {
		window.removeEventListener('beforeinstallprompt', onPrompt);
		window.removeEventListener('appinstalled', onInstalled);
	};
}

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
	if (!deferred) return 'unavailable';
	await deferred.prompt();
	const { outcome } = await deferred.userChoice;
	// The event is single-use: Chromium will fire a fresh one if still eligible.
	deferred = null;
	install.available = false;
	return outcome;
}
