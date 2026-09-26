/**
 * Max accepted inbound webhook body size (bytes). Enforced during raw-body read
 * so a hostile sender can't stream an unbounded payload into a serverless fn.
 * 1 MiB comfortably covers real webhook payloads (Stripe/GitHub cap similarly).
 */
export const WEBHOOK_BODY_MAX_BYTES = 1_048_576;
