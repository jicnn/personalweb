// Geolocation-based language routing (Vercel Edge Middleware).
// Visitors from mainland China are served the Chinese version (/zh/...),
// everyone else the English default. An explicit choice (cookie set by the
// language switcher) always wins over geolocation.
const COOKIE_NAME = 'site_lang';

// Page requests have clean URLs (no file extension). Everything with a dot
// (rss.xml, sitemap-index.xml, favicon.ico, images, ...) is served as-is.
const isPagePath = (pathname: string) => !pathname.includes('.');

export default function middleware(request: Request) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!isPagePath(path)) return;

  const isZhPath = path === '/zh' || path.startsWith('/zh/');

  // Explicit language choice from cookie wins over geolocation
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)site_lang=(en|zh)(?:;|$)/);
  const chosen = match ? (match[1] as 'en' | 'zh') : null;

  // Decide target language: cookie first, otherwise IP country
  const country = request.headers.get('x-vercel-ip-country');
  const wantsZh = chosen ? chosen === 'zh' : country === 'CN';

  if (wantsZh && !isZhPath) {
    return redirectTo('/zh' + (path === '/' ? '' : path) + url.search, 'zh');
  }

  if (!wantsZh && isZhPath) {
    return redirectTo((path.slice(3) || '/') + url.search, 'en');
  }

  return;
}

function redirectTo(path: string, lang: 'en' | 'zh') {
  return new Response(null, {
    status: 307,
    headers: {
      Location: path,
      'Set-Cookie': `${COOKIE_NAME}=${lang}; Path=/; Max-Age=31536000; SameSite=Lax`,
    },
  });
}

export const config = {
  matcher: '/((?!_astro/|api/).*)',
};
