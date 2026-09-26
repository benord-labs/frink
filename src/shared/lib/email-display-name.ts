/** Regex to extract display name from email like "John Doe <john@example.com>" */
const EMAIL_NAME_REGEX = /^([^<]+)</;

/** Extract display name from email like "John Doe <john@example.com>" */
export function extractEmailDisplayName(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const match = email.match(EMAIL_NAME_REGEX);
  if (match) return match[1].trim();
  return email;
}
