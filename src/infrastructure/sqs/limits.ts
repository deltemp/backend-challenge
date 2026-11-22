/** SQS accepts at most ten entries per batch call. */
export const SQS_MAX_BATCH_ENTRIES = 10;

/** Longest wait to open a connection to SQS, for every client. */
export const SQS_CONNECTION_TIMEOUT_MS = 3000;
