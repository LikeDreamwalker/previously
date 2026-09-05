/**
 * Fallback for the implicit `children` slot — required once the layout takes
 * a parallel slot (@modal), so hard loads that can't recover the children
 * state render nothing instead of a 404.
 */
export default function Default() {
  return null;
}
