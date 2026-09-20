import { createAvatar } from '@dicebear/core';
import { thumbs } from '@dicebear/collection';

/**
 * Deterministic avatar from a seed. Generated locally rather than fetched from
 * an avatar service: this app is meant to work on a plane, and a profile
 * picture that needs a network round trip is a profile picture that is
 * sometimes a broken image.
 *
 * `thumbs` is one style rather than a picker. A gallery of styles is a
 * decision the traveller does not want to make about an icon they will see at
 * 28px.
 */
export function avatarSvg(seed: string): string {
	return createAvatar(thumbs, {
		seed,
		radius: 50,
		// Pulled from the gelato accents so a generated avatar looks like it
		// belongs to this app rather than to DiceBear.
		backgroundColor: ['f6b89a', 'f3d9a4', 'aee0c8', 'b9d3f0', 'e9c6dd'],
		backgroundType: ['solid']
	}).toString();
}

/** A data URI usable straight in `src`. */
export function avatarDataUri(seed: string): string {
	// encodeURIComponent rather than base64: the SVG is small, and this keeps
	// it legible in devtools when something looks wrong.
	return `data:image/svg+xml;utf8,${encodeURIComponent(avatarSvg(seed))}`;
}

/** A fresh seed for the re-roll button. */
export const newSeed = () => Math.random().toString(36).slice(2, 10);
