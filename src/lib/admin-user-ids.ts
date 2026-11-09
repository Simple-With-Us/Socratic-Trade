/**
 * User ids that should receive system-wide alerts (provider outages, storage
 * warnings).  Primary always maps to `"local"`.  Extra admins in
 * ADMIN_USER_EMAILS get their own `u_<hash>` ids when they are not primary aliases.
 */

import { adminEmails, primaryEmails } from "./auth/admin-emails";
import { userIdForEmail } from "./auth/identity";

/** Unique admin user ids.  Always includes `"local"` for the primary operator. */
export function listAdminUserIds(): string[] {
  const ids = new Set<string>(["local"]);
  for (const email of primaryEmails()) {
    ids.add(userIdForEmail(email));
  }
  for (const email of adminEmails()) {
    ids.add(userIdForEmail(email));
  }
  return [...ids];
}
