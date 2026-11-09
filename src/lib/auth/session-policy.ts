/** Sliding session cookie lifetime (JWT exp may refresh up to this from each touch). */
export const SESSION_SLIDING_MAX_AGE_SEC = 30 * 24 * 60 * 60;

/**
 * Hard ceiling from first sign-in: sliding refresh never extends past this many seconds after
 * the server session row's created_at.
 */
export const SESSION_ABSOLUTE_MAX_AGE_SEC = 90 * 24 * 60 * 60;

export const SESSION_JWT_SID_CLAIM = "sid";
export const SESSION_JWT_ABS_EXP_CLAIM = "absExp";
