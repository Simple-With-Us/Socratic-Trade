/** Sliding session cookie lifetime (JWT exp may refresh up to this from each touch). */
export const SESSION_SLIDING_MAX_AGE_SEC = 30 * 24 * 60 * 60;

/**
 * Hard ceiling from first sign-in: sliding refresh never extends past this many seconds after
 * the server session row's created_at.
 */
export const SESSION_ABSOLUTE_MAX_AGE_SEC = 90 * 24 * 60 * 60;

export const SESSION_JWT_SID_CLAIM = "sid";
export const SESSION_JWT_ABS_EXP_CLAIM = "absExp";

/**
 * Last Node-side session touch (seconds). Edge middleware trusts Auth.js cookies only while
 * `srvTouch + SESSION_EDGE_TRUST_SEC` is in the future (see session-edge.ts).
 */
export const SESSION_JWT_SRV_TOUCH_CLAIM = "srvTouch";

/**
 * Edge cannot query SQLite for revocation. Middleware accepts session cookies only when the JWT
 * was server-touched within this window; Node paths always check `auth_sessions`.
 */
export const SESSION_EDGE_TRUST_SEC = 5 * 60;
