import type { NextConfig } from 'next'

/**
 * Security headers.
 *
 * A canvas app takes untrusted input in two places — the board document itself and the share token
 * in the URL — so the baseline headers are not ceremony. `frame-ancestors 'none'` in particular stops
 * the board being clickjacked: a malicious page could otherwise overlay transparent UI and capture
 * every drag a collaborator makes.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    // Geolocation, camera and microphone have no business in a whiteboard.
    value: 'camera=(), microphone=(), geolocation=(), payment=()',
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      // Next injects inline bootstrap scripts; styles need inline for the runtime CSS variables.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      // The realtime socket is a different origin from the app, by design.
      "connect-src 'self' https: wss:",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  },
]

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig
