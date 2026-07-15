const ROOM_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomToken(byteLength = 24): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return base64Url(bytes);
}

export function randomRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join("");
}

export async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return base64Url(new Uint8Array(digest));
}

export async function tokenMatches(token: string, expectedHash: string): Promise<boolean> {
  const actual = await hashToken(token);
  if (actual.length !== expectedHash.length) return false;
  let mismatch = 0;
  for (let index = 0; index < actual.length; index += 1) {
    mismatch |= actual.charCodeAt(index) ^ expectedHash.charCodeAt(index);
  }
  return mismatch === 0;
}
