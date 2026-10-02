// Base64 of a byte array, without `btoa` and without `Buffer`.
//
// The download primitive hands the bot the file it fetched in the client's
// browser profile. `btoa` wants a binary string, which means building a second
// copy of the whole document as a JS string and blowing the call stack on a
// large file; this encoder walks the bytes once and appends in place, so the
// only allocation is the result itself.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  const length = bytes.length;
  const whole = length - (length % 3);
  for (let i = 0; i < whole; i += 3) {
    const chunk = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      ALPHABET[(chunk >> 18) & 63]! +
      ALPHABET[(chunk >> 12) & 63]! +
      ALPHABET[(chunk >> 6) & 63]! +
      ALPHABET[chunk & 63]!;
  }
  const rest = length - whole;
  if (rest === 1) {
    const chunk = bytes[whole]! << 16;
    out += ALPHABET[(chunk >> 18) & 63]! + ALPHABET[(chunk >> 12) & 63]! + "==";
  } else if (rest === 2) {
    const chunk = (bytes[whole]! << 16) | (bytes[whole + 1]! << 8);
    out +=
      ALPHABET[(chunk >> 18) & 63]! +
      ALPHABET[(chunk >> 12) & 63]! +
      ALPHABET[(chunk >> 6) & 63]! +
      "=";
  }
  return out;
}