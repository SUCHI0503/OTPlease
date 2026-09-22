import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

// Returns the number in E.164 format (like +919876543210), or null if it is not valid.
// defaultCountry is used when the number has no + prefix. Later this becomes a per-application setting.
export function normalizePhone(input: string, defaultCountry: CountryCode = "IN"): string | null {
  const parsed = parsePhoneNumberFromString(input.trim(), defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}
