import type { Handle } from '@sveltejs/kit';
import { SECURITY_HEADER_ENTRIES } from '$lib/security-headers.js';

const applySecurityHeaders = (headers: Headers) => {
  for (const [header, value] of SECURITY_HEADER_ENTRIES) {
    headers.set(header, value);
  }
};

const rewrapResponse = (response: Response): Response => {
  // Clone FIRST before touching anything
  const cloned = response.clone();
  
  const headers = new Headers(cloned.headers);
  applySecurityHeaders(headers);

  return new Response(cloned.body, {
    status: cloned.status,
    statusText: cloned.statusText,
    headers
  });
};

export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event, {
    filterSerializedResponseHeaders: (name) => name === 'content-type'
  });

  return rewrapResponse(response);
};
