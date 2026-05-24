export interface SecretPresence {
  present: boolean;
  byte_length: number;
}

// Suffix-mask preserves workspace/channel id so operators recognise which webhook is configured without leaking the token segment.
export function redactSlackUrl(url: string | undefined): string | null {
  if (url === undefined) return null;
  return `${url.slice(0, url.lastIndexOf("/") + 1)}****`;
}

// byte_length lets operators detect truncation/encoding bugs without ever seeing the secret value.
export function redactSecret(value: string | undefined): SecretPresence {
  if (value === undefined || value === "") {
    return { present: false, byte_length: 0 };
  }
  return { present: true, byte_length: Buffer.byteLength(value, "utf8") };
}
