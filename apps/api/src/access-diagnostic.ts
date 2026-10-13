import type { AccessAssertionFailure } from './access-jwt-verifier.js';

export type AccessDiagnosticReason =
  | AccessAssertionFailure
  | 'assertion_identity_not_accepted'
  | 'unexpected_verification_error';

const HINT_BY_REASON: Record<AccessDiagnosticReason, string> = {
  missing_assertion: 'Cloudflare Access did not attach an assertion to this request. Check that the Access application covers this exact hostname and path and that no bypass or service-auth policy matched it.',
  malformed_assertion: 'The assertion header was not a well-formed Access token. A proxy between Cloudflare and the origin may be rewriting or truncating request headers.',
  unsupported_algorithm: 'The assertion was signed with an unexpected algorithm, so it did not come from Cloudflare Access.',
  invalid_signature: 'The assertion signature did not verify against the team signing keys. The token was minted for another issuer or audience, or its key material is stale.',
  unknown_key: 'The assertion names a signing key that is absent from the cached JWKS. Cloudflare may have rotated Access signing keys and the origin has not fetched the new key set yet.',
  jwks_unavailable: 'The origin could not fetch the team JWKS document. Check container DNS and egress to the team domain.',
  wrong_issuer: 'The assertion issuer differs from CLOUDFLARE_ACCESS_ISSUER. The Zero Trust team domain or the Access application changed.',
  wrong_audience: 'The assertion audience differs from CLOUDFLARE_ACCESS_AUDIENCE. The Access application was recreated after this value was copied, or a different application covers this hostname.',
  wrong_token_type: 'The assertion is not an Access application token (its type claim is not app).',
  invalid_subject: 'The assertion carries no usable subject, so it cannot identify a principal.',
  invalid_lifetime: 'The assertion lifetime claims (exp/nbf) are missing or malformed.',
  expired_assertion: 'The assertion has expired. Reload through the Access login, and check the origin clock.',
  inactive_assertion: 'The assertion is not valid yet. The origin clock is most likely behind Cloudflare time.',
  assertion_identity_not_accepted: 'The assertion identity does not match the identity class this surface accepts: user surfaces require a user identity, and the API-key gateway requires the pinned service-token identity.',
  unexpected_verification_error: 'Assertion verification failed unexpectedly. The API log records the same code.'
};

const CHECKS = [
  'The Cloudflare Access application must cover this exact hostname and path, and its application audience (AUD) must equal CLOUDFLARE_ACCESS_AUDIENCE.',
  'The request must arrive through Cloudflare. A browser that resolves the origin address directly bypasses Access and reaches this page.',
  'CLOUDFLARE_ACCESS_ISSUER and CLOUDFLARE_ACCESS_JWKS_URL must match the live team domain, and the API container must reach that JWKS URL.',
  'The API logs this reason code for every rejection: docker compose logs api, or journalctl -u cloud-harness-mcp.service.'
];

export function renderAccessDiagnostic(reason: AccessDiagnosticReason): string {
  const checks = CHECKS.map((check) => `<li>${check}</li>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Dashboard unavailable | Cloud Harness</title>
</head>
<body>
<h1>Dashboard unavailable</h1>
<p>This request reached the Cloud Harness origin without a valid Cloudflare Access assertion, so the API could not identify you. The interactive login did not fail here: the origin never received a verifiable assertion.</p>
<p>Reason code: <code>${reason}</code></p>
<p>${HINT_BY_REASON[reason]}</p>
<h2>Checks</h2>
<ul>${checks}</ul>
<p>This page never contains tokens, assertions, or identity claims.</p>
</body>
</html>
`;
}
