/** "+919876543210" -> "+91*******10". Used wherever a recipient must be logged or stored for display. */
export function maskRecipient(to: string): string {
  return to.length <= 4 ? "****" : `${to.slice(0, 3)}${"*".repeat(to.length - 5)}${to.slice(-2)}`;
}
