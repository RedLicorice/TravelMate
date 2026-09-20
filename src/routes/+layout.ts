// Pure SPA. Nothing is prerendered, so adapter-static emits only the fallback;
// the build script copies it to index.html so the site has a root document.
export const ssr = false;
export const prerender = false;
