/** SSH account names are case-sensitive; do not case-fold or Unicode-normalize. */
export function normalizeSshUsername(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid SSH username')
  const username = value.trim()
  if (!username || username.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(username)) throw new Error('Invalid SSH username')
  return username
}
