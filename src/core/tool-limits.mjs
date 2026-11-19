/**
 * One byte budget for both spilling and model-facing serialization. Keeping
 * these equal prevents the dead zone where a result is too large to send but
 * too small to be spilled (and therefore has no read/query_result pointer).
 */
export const MAX_TOOL_RESULT_BYTES = 20 * 1024;
