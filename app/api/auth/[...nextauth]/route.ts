// Auth.js v5 catch-all route handler.
// Handles: GET/POST /api/auth/callback/google, /api/auth/signin, /api/auth/signout, etc.
import { handlers } from "../../../../src/lib/auth/auth";

export const { GET, POST } = handlers;
