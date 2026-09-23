import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY } from '$env/static/public';
import { authStorage } from './store/idb';

// The publishable key is public by design: it names the project, it authorises
// nothing. RLS is the boundary.
export const supabase = createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
	// pkce, not the implicit default: implicit hands back the access and
	// refresh tokens in the URL fragment, where an extension, the history and
	// performance.getEntries() can all read them until auth-js clears it. PKCE
	// returns a single-use code instead.
	auth: {
		// Where the service worker can read it too: it is what sends queued
		// edits once the tab has gone.
		storage: authStorage,
		persistSession: true,
		autoRefreshToken: true,
		detectSessionInUrl: true,
		flowType: 'pkce'
	}
});
