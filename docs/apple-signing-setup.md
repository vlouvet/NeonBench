# Apple code-signing setup for NeonBench releases

This is a one-time human walkthrough. By the end you'll have six GitHub Secrets configured so the CI release workflow (Tier 1 #70b) can sign + notarize macOS binaries automatically.

If you've never done this before, **budget 60-90 minutes**. Most of the time is waiting for Apple's UI to refresh after each step.

---

## Prerequisites checklist

- [ ] Active Apple Developer Program membership ($99/yr — confirm at https://developer.apple.com/account → "Membership")
- [ ] macOS workstation with Xcode Command Line Tools installed (`xcode-select -p` returns a path)
- [ ] Admin access to the `vlouvet/NeonBench` GitHub repository (you need to add Secrets)

If any of those is missing, fix that first; the rest of this guide assumes you have them.

---

## Step 1 — Confirm you have a "Developer ID Application" certificate (or create one)

There are several types of Apple certificates. The one we need is **"Developer ID Application"** — used for distributing macOS apps **outside the Mac App Store**. It is NOT the same as:

- "Mac Development" (for running locally during development — useless for distribution)
- "Mac App Distribution" (for App Store submissions only)
- "Apple Development" (iOS-flavor, also useless here)

### 1a. Open Keychain Access on your mac

`Cmd-Space` → type "Keychain Access" → Enter.

In the left sidebar, select the **"login"** keychain and the **"My Certificates"** category.

Look for an entry like:

> **Developer ID Application: Vicente Louvet (TEAMID12345)**

If you see it, skip to Step 2.

### 1b. If it's not there — create one

1. Open https://developer.apple.com/account/resources/certificates/list in your browser.
2. Click the blue **"+"** button (top-left of the certificate list).
3. Under "Software", select **"Developer ID Application"** and click **Continue**.
4. The next page asks for a Certificate Signing Request (CSR). Generate one locally:
   - In Keychain Access: menu **"Keychain Access" → "Certificate Assistant" → "Request a Certificate from a Certificate Authority…"**
   - User Email Address: your Apple ID email
   - Common Name: your name (e.g. "Vicente Louvet")
   - Request is: **"Saved to disk"**
   - Click Continue, save the `.certSigningRequest` file to your Desktop.
5. Back in the browser, upload that `.certSigningRequest` file and click **Continue**.
6. Apple generates the certificate. Click **Download** — you get a `developerID_application.cer` file.
7. **Double-click** the `.cer` file. Keychain Access opens and asks where to install it. Pick **"login"** keychain.
8. Re-check Keychain Access → "My Certificates" → you should now see the **"Developer ID Application: ..."** entry. Expand the disclosure triangle to confirm a private key is attached.

### 1c. Note your Team ID

Your Team ID is a 10-character alphanumeric string visible at https://developer.apple.com/account → "Membership". You'll need it for `MACOS_CERT_IDENTITY` later. It's also visible in the parentheses of the certificate name in Keychain Access (e.g. `Developer ID Application: Vicente Louvet (TEAMID12345)`).

---

## Step 2 — Export the certificate as a .p12 file

This is what CI will import into a temporary keychain to sign binaries.

1. In Keychain Access, select the **"Developer ID Application: ..."** entry under "My Certificates".
2. Right-click → **"Export 'Developer ID Application: ...'"**.
3. File Format: **"Personal Information Exchange (.p12)"**.
4. Save it to your Desktop as `neonbench-cert.p12`.
5. **Set a password** when prompted. Use a long random one — you'll only need it once when adding the GitHub Secret. Save this password to your password manager.
6. macOS may prompt for your login keychain password — that's just unlocking the export, not the new password.

You now have `~/Desktop/neonbench-cert.p12`. **Treat this like a private key** — anyone with this file + its password can sign software as you. Don't share it; don't email it; don't check it into git.

---

## Step 3 — Base64-encode the .p12 for the GitHub Secret

GitHub Secrets are plain strings. Encode the binary .p12:

```sh
base64 -i ~/Desktop/neonbench-cert.p12 | tr -d '\n' > ~/Desktop/neonbench-cert.p12.base64
```

The `tr -d '\n'` strips newlines so the secret value is one continuous line. Open that file in any text editor and you'll see a long base64 blob — that's what you paste into GitHub.

```sh
# Verify the encoding round-trips:
base64 -d -i ~/Desktop/neonbench-cert.p12.base64 -o /tmp/round-trip.p12 && \
  shasum -a 256 ~/Desktop/neonbench-cert.p12 /tmp/round-trip.p12
```

The two SHA256 hashes must match. If they don't, your encoding got mangled — re-run.

---

## Step 4 — Generate an App Store Connect API key

This is a separate credential from the signing certificate. It authorizes CI to submit notarization requests to Apple's notary service.

> **Heads-up:** the API key page is in **App Store Connect** (https://appstoreconnect.apple.com), NOT the Apple Developer portal. Same Apple ID logs into both, but they're different sites with different navigation.

1. Open https://appstoreconnect.apple.com → **"Users and Access"** tab → **"Integrations"** sub-tab → **"App Store Connect API"** section.
2. The first time you visit this page, you may need to click **"Request Access"** to enable API keys for your account. Approve it (instant if you're the account holder).
3. Click the **"+"** button next to "Active" to generate a new key.
4. Name: `NeonBench Notarization`. Access: **"Developer"** is the minimum role that allows notarization. Click **Generate**.
5. Apple shows the new key with a **"Download API Key"** button. **You can only download it once.** Click it and save the `AuthKey_XXXXXXXXXX.p8` file to your Desktop.
6. From the same page, note:
   - **Key ID** — 10-character alphanumeric (e.g. `ABC123DEF4`). Visible in the key list.
   - **Issuer ID** — UUID at the top of the API Keys page (e.g. `12345678-1234-1234-1234-123456789012`). Click "Copy" next to "Issuer ID".

You now have three pieces of info: the .p8 file, the Key ID, the Issuer ID. **The .p8 file is also private** — same threat model as the .p12.

---

## Step 5 — Find your full codesign identity name

Run this on your mac:

```sh
security find-identity -v -p codesigning
```

You'll see output like:

```
1) ABC123... "Apple Development: Some Name (XYZ)"
2) DEF456... "Developer ID Application: Vicente Louvet (TEAMID12345)"
   2 valid identities found
```

The string in quotes for the **"Developer ID Application"** entry is what goes into `MACOS_CERT_IDENTITY`. **Copy it exactly**, including the parentheses and Team ID.

---

## Step 6 — Add the six GitHub Secrets

Open https://github.com/vlouvet/NeonBench/settings/secrets/actions in your browser. (You need admin access to the repo.)

For each secret below, click **"New repository secret"**, paste the value, click **"Add secret"**.

| Secret name | Value |
|---|---|
| `MACOS_CERT_P12_BASE64` | Contents of `~/Desktop/neonbench-cert.p12.base64` (the long base64 line). |
| `MACOS_CERT_PASSWORD` | The password you set when exporting the .p12 in Step 2. |
| `MACOS_CERT_IDENTITY` | The full identity string from Step 5 (e.g. `Developer ID Application: Vicente Louvet (TEAMID12345)`). |
| `ASC_API_KEY_ID` | The 10-character Key ID from Step 4. |
| `ASC_API_ISSUER_ID` | The UUID Issuer ID from Step 4. |
| `ASC_API_KEY_P8` | The **contents** of the `AuthKey_XXX.p8` file from Step 4 (open it in a text editor; it starts with `-----BEGIN PRIVATE KEY-----`). Paste the whole thing including the BEGIN/END markers. Multi-line is fine — GitHub preserves newlines in secret values. |

---

## Step 7 — Verify by tagging a test release

Once the implementation work for sub-PR 70b lands, tag a release candidate to test the pipeline end-to-end:

```sh
git checkout main
git pull
git tag v0.0.1-signing-test
git push origin v0.0.1-signing-test
```

Then watch the workflow at https://github.com/vlouvet/NeonBench/actions. The `build-macos` job should:

1. Import the cert (no errors)
2. Build both darwin binaries
3. Codesign each (no errors)
4. Submit to notary, wait, and receive `Status: Accepted` (5-15 min per binary)
5. Staple the ticket
6. Recompute the SHA256 (binary contents change after stapling)

When the workflow finishes, go to https://github.com/vlouvet/NeonBench/releases. Download `neonbench-darwin-arm64` (or `-amd64` if you're on Intel) on a **fresh mac** — one that has never seen the binary. Open it. **No Gatekeeper warning.** The binary launches normally.

If you don't have a fresh mac to test on, you can simulate one by deleting the quarantine attribute and re-applying it:

```sh
# Add quarantine flag (simulates a fresh download):
xattr -w com.apple.quarantine "0001;00000000;Safari;" ./neonbench-darwin-arm64
# Now try to run it:
./neonbench-darwin-arm64
# Should launch without "unidentified developer" warning.
```

If the warning does appear, something went wrong — most likely:

- The codesign step is using the wrong identity (check `MACOS_CERT_IDENTITY`).
- The notarytool submission failed silently (check the workflow logs for the `xcrun notarytool submit` step's output — it should say `Accepted`).
- The staple step ran before notarization completed (notarytool's `--wait` should prevent this; if the workflow didn't wait, check timeout values).

---

## Step 8 — Cleanup (after verifying everything works)

Once you've successfully tagged a working signed release:

- [ ] **Delete `~/Desktop/neonbench-cert.p12`** and `~/Desktop/neonbench-cert.p12.base64` from your mac (the secret is in GitHub now).
- [ ] **Delete `~/Desktop/AuthKey_XXX.p8`** (same reason).
- [ ] **Empty Trash** so the files aren't recoverable.
- [ ] Optionally delete the test tag: `git push --delete origin v0.0.1-signing-test`. The release entry on GitHub stays unless you also delete it via the UI; it's not harmful to keep around.

The cert + private key are still in your login keychain on this mac — that's fine, you'll need them for any local signing tests via `scripts/build.sh --sign`.

---

## Renewal / rotation

- The **Developer ID Application certificate is valid for 5 years** from issue. When it expires, repeat Steps 1b–3 with a new cert and re-update the `MACOS_CERT_P12_BASE64` + `MACOS_CERT_PASSWORD` + `MACOS_CERT_IDENTITY` secrets. The Team ID stays the same (it's tied to your developer account, not the cert).
- The **App Store Connect API key has no expiration** by default but you can revoke and rotate at any time from the same UI. If you do, update `ASC_API_KEY_ID` + `ASC_API_KEY_P8` (the Issuer ID stays).
- **If your laptop is lost/stolen**, revoke the certificate from https://developer.apple.com/account → Certificates → click the cert → "Revoke". Generate a new one. Update the GitHub Secrets. The old cert is dead; any binary signed with it is still valid (signatures don't get retroactively invalidated unless Apple revokes the cert *and* the binary lacks a notarization ticket — notarized binaries survive cert revocation, which is one of the reasons we notarize).

---

## Troubleshooting cheat sheet

| Symptom | Likely cause |
|---|---|
| `errSecInternalComponent` during codesign in CI | Keychain wasn't unlocked. Re-check the `security unlock-keychain` step. |
| `User interaction is not allowed` | Same — keychain locked or partition list not set. The `security set-key-partition-list` step in the workflow handles this. |
| Notarytool: `Status: Invalid` | The binary failed Apple's malware scan or has a bad entitlement. Check the JSON log Apple returns: `xcrun notarytool log <submission-id> --key ... --key-id ... --issuer ...`. |
| Notarytool: timeout exceeded | Apple's queue is slow that day. Increase `--timeout` to 60m. |
| Stapler fails: "could not find ticket" | Notarization didn't actually succeed despite the wait. Check notarytool log. |
| Gatekeeper warning despite signing | Signed but not notarized OR notarized but not stapled. The staple is what makes it work offline (offline machines can't query Apple's notary service, so the ticket must be embedded). |
| Local mac can run the binary but a colleague's can't | Their mac still has the quarantine attribute and may need an internet connection on first run (to fetch the staple). Use the fresh-mac test or `xattr -w com.apple.quarantine` simulation in Step 7. |

---

## What to do if you get stuck

1. **Read the workflow logs end-to-end.** The error is almost always there in plain English — Apple's tools are noisy but informative.
2. **Don't share secrets while debugging.** If you paste workflow output anywhere, redact the API key ID and any base64 blobs first.
3. **Apple Developer Forums** (https://developer.apple.com/forums/tags/notarization) is the canonical place for notarization quirks.

Once Step 7 succeeds, you're done with this guide forever (until renewal in 2031). The remaining work is purely software in the NeonBench repo.
