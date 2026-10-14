// Security headers for every coordinator response: the single source of truth, mirroring senet's
// tools/security-headers.js. Smith's dashboard ships no inline scripts, no third-party scripts and no
// embeds, so its policy can be stricter than senet's:
//   * script-src/style-src 'self' only; img-src 'self' keeps remote images in untrusted chat Markdown
//     (tracking pixels) from loading.
//   * frame-ancestors 'none': the dashboard is never framed (senet allows Discord's activity iframe).
//   * COOP same-origin: sign-in uses full-page redirects, not popups, so no opener channel is needed.
//   * CORP same-origin: nothing here is meant to be embedded by another site.
//   * HSTS without `preload`, as in senet: preload submission is a separate, near-irreversible step.
// Violations are reported to /csp-report (see cspReport) so a blocked script shows up in the Worker
// logs instead of only in one person's browser console.
export const CSP_REPORT_PATH = '/csp-report';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  'upgrade-insecure-requests',
  'report-to csp',
].join('; ');

function baseline(origin: string): Record<string, string> {
  return {
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Reporting-Endpoints': `csp="${origin}${CSP_REPORT_PATH}"`,
  };
}

// Returns a new Response: asset, Durable Object and fetch responses can carry immutable headers.
export function secure(response: Response, origin: string): Response {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(baseline(origin))) secured.headers.set(name, value);
  if ((secured.headers.get('Content-Type') ?? '').toLowerCase().includes('text/html')) {
    secured.headers.set('Content-Security-Policy', CSP);
    // no-transform stops Cloudflare's edge from injecting scripts this CSP blocks (JavaScript
    // Detections' inline snippet, the Web Analytics beacon).
    const cacheControl = secured.headers.get('Cache-Control');
    if (!cacheControl?.includes('no-transform')) secured.headers.set('Cache-Control', cacheControl ? cacheControl + ', no-transform' : 'no-transform');
  }
  return secured;
}

// Browsers POST violation reports here without credentials. Record a compact, bounded summary of
// each (never the raw body) and accept everything else silently, as senet's ratings Worker does.
export async function cspReport(request: Request): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  const text = await readCapped(request, 16384);
  let reports: unknown = [];
  try { reports = JSON.parse(text); } catch { /* malformed: ignored */ }
  const list = Array.isArray(reports) ? reports.slice(0, 10) : [reports];
  for (const report of list) {
    const body = (report as { body?: Record<string, unknown> } | null)?.body ?? (report as { 'csp-report'?: Record<string, unknown> } | null)?.['csp-report'];
    if (!body || typeof body !== 'object') continue;
    const field = (...keys: string[]) => { for (const key of keys) if (typeof body[key] === 'string') return (body[key] as string).slice(0, 200); return undefined; };
    console.warn(JSON.stringify({ event: 'csp_violation', directive: field('effectiveDirective', 'effective-directive', 'violated-directive'),
      blocked: field('blockedURL', 'blocked-uri'), page: pathOf(field('documentURL', 'document-uri')), line: body.lineNumber ?? body['line-number'] }));
  }
  return new Response(null, { status: 204 });
}

function pathOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).pathname; } catch { return undefined; }
}

async function readCapped(request: Request, limit: number): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { await reader.cancel(); return ''; }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(buffer);
}
