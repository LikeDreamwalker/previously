/**
 * Fallback for the @modal slot: on hard navigation (or any route that isn't
 * the intercepted /timeline) the slot renders nothing. Required by the
 * parallel-routes convention — without it unmatched hard loads 404.
 */
export default function Default() {
  return null;
}
