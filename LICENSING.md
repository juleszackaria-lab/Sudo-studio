# Sudo Studio - Licensing (P11, P16)

Offline license enforcement (Ed25519). The product verifies keys locally;
no license server is ever contacted.

## 1. Key format

`b64u(payloadJSON).b64u(signature64B)` - payload:

```json
{
  "licenseId": "LIC-ACME-001",
  "client": "Acme",
  "edition": "team | enterprise | community",
  "seats": 10,
  "issuedAt": "2026-10-16T23:12:54.224Z",
  "expiresAt": "2026-11-15T23:12:54.222Z",
  "features": ["chat", "doctor", "sdk", "devops", "environment", "agent"],
  "machineId": "optional-host-binding"
}
```

The signature covers the base64url payload part. `seats: 999999` is the
documented "unlimited" convention.

## 2. Verification chain (both license.js copies, kept mirrors)

1. format (`a.b` charset), JSON payload, required fields
2. known edition, integer seats >= 1, valid dates
3. `features` subset of the edition's list (server never trusts it blindly)
4. Ed25519 signature against the build's embedded public key
5. expiry (`expiree le ...`), future-issue skew (5 min), revocation list
6. optional machine binding, tamper-evident clock seal (rollback detection)

Any failure degrades to Community with a precise reason. Refusal message:
"Necessite l'edition <Team|Enterprise>" (accents in the product strings).

## 3. Editions and features

| Feature | Min. edition | UI enforcement | Backend enforcement |
|---|---|---|---|
| chat | community | open | `/api/ai/*` open |
| doctor | community | open | `/api/system/doctor` open |
| sdk | community | open | `/api/sdk/*` open |
| devops | team | `openDevOpsPanel` gate | 6 `/api/devops/*` routes, 403 |
| environment | team | panel gate (P11) | 5 `/api/environment/*` routes, 403 |
| agent | team | `openAgentPanel` gate | none (extension-side agent engine) |
| security | enterprise | panel gate (P11) | none (extension-side audit) |
| duplication | enterprise | panel gate (P11) | none (extension-side) |
| central | enterprise | panel gate (P11) | `/admin/users` 403 |
| cicd | enterprise | `generateCICD` gate | `/api/devops/generate` per-type check |
| license | enterprise | panel INTENTIONALLY OPEN (activation path; revocation import open per P11 H7/H8 spec) | none (no license routes; middleware 403s it if ever wired) |

Model/policy routes (`/api/models/*`) are base functionality, outside the
edition model (admin policies in `central_policies.json` apply instead).

## 4. Key locations

- PRIVATE keys: `%USERPROFILE%\.sudo-studio-keys\<env>\license_private.pem`
  on the owner's PC (one dir per environment: `prod`, `dev`). NEVER in git
  (both repos ignore `*private*.pem`, `*-private.key`, `private-keys/`,
  `secrets/`, `keys/` - see each `.gitignore`).
- PRODUCTION public key: constant `PRODUCT_PUBLIC_KEY_SPKI_B64` in BOTH
  `backend/src/license/license.js` and `sudo-ai-extension/src/license/license.js`
  (mirrors). Exactly one key per file, no runtime switch, no env override.
- DEVELOPMENT public key: `dev-pubkey/license_public.spki.b64` in the
  `sudo-studio-packager` repo (+ `FINGERPRINT.txt`). Development builds embed
  it via `node scripts/patch-pubkey.js` on BUILD COPIES only.
- Fingerprint of the embedded key MUST be recorded next to every release.

## 5. PRODUCTION ceremony (owner only - NEVER by an agent)

On the owner's own PC, offline, inside the packager repo:

```
node license-keygen.js generate-keypair --out %USERPROFILE%\.sudo-studio-keys\prod
```

1. Copy the printed `PRODUCT_PUBLIC_KEY_SPKI_B64` into BOTH license.js files,
   then build/release. Record the fingerprint with the release.
2. Store `license_private.pem` on an HSM or encrypted offline vault
   (`sudo-studio-license-private-<fingerprint8>.pem`); backup on a second
   offline medium elsewhere. No cloud sync folder.
3. Issue customer keys with `issue --keydir ... --client ... --edition ...
   --seats ... (--days N | --expires YYYY-MM-DD)`.
4. Rotation (scheduled or on suspected leak): new pair, embed, release,
   re-issue active keys, publish revocation list for old `licenseId`s,
   destroy old private material.

## 6. Development procedure

```
node scripts/patch-pubkey.js dev-pubkey/license_public.spki.b64 <build copies of both license.js>
node license-keygen.js issue --keydir %USERPROFILE%\.sudo-studio-keys\dev \
  --client "Test" --edition enterprise --seats 999999 --days 30
```

Development keys verify ONLY on development builds (and production keys only
on production builds - proven by `test-keygen.js` K10 and `test-p16-editions.js` E1).
`--allow-expired` issues expired TEST keys; the tool refuses them otherwise.

## 7. No-bypass policy (audited)

- No private key, no license key, no key table in either repo.
- No environment variable, flag, or backdoor switches the product key:
  verify with `git grep -nE "PRIVATE KEY|private[_-]?key|BEGIN.*PRIVATE|SUDO_.*(KEY|LICENSE)|BACKDOOR|bypass.*licen[cs]e"`
  (expect only keygen-tool code, test fixtures, and detection regexes).
- The `opts.publicKeySpkiB64` parameter of `verifyLicenseKey` is a test seam;
  production callers pass no options (LicensePanel, middleware).
