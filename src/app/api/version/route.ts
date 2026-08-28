/**
 * GET /api/version — kernel version + deployment mode.
 *
 * The local client CLI reads this to check kernel/client compatibility before
 * driving the kernel (version is bound to client releases, see
 * doc/design/v0.9-client.md §6). Read-only; the payload is not a secret, so
 * this endpoint intentionally has no auth — same as the other read endpoints.
 */

import { APP_VERSION } from "@/lib/version/constants";
import { getMode } from "@/lib/mode";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ version: APP_VERSION, mode: getMode() });
}
