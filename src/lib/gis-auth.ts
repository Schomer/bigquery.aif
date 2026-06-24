// src/lib/gis-auth.ts
// Shared access-token store.
// The auth context writes the token here after Firebase Auth sign-in;
// BigQuery/Vertex AI callers read it via getAccessToken().

let _accessToken: string | null = null;

export function setAccessToken(token: string | null) {
  _accessToken = token;
}

export function getAccessToken(): string | null {
  return _accessToken;
}
