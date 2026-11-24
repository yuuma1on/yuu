# Windows releases

PULSE uses the public repository `yuuma1on/yuu`. A push to `main` builds and tests the Windows x64 installer and uploads the installer, blockmap, and `latest.yml` as a GitHub Actions artifact. It does not publish a release. The native Windows check silently installs the actual installer and launches the installed app to exercise its demo analysis, version, secure context, and renderer sandbox.

Publishing runs three isolated jobs: build and native smoke test; signing on a fresh runner; and publishing with repository write permission. Only the signing command receives `PULSE_UPDATE_PRIVATE_KEY`. Dependency installation in that job disables lifecycle scripts. Only the final publishing job has `contents: write` permission. Actions are pinned to commit SHAs verified against their upstream repositories.

## One-time signing setup

Generate an Ed25519 key pair once, before the first release. Choose a private-key destination outside this repository, with a protected backup:

```sh
node scripts/generate-update-key.mjs --private-key /absolute/private/location/pulse-update-private.pem
```

The command refuses existing key files and repository-local private keys. It writes the public key to `desktop/update-public-key.pem` and prints only its SHA-256 public-key fingerprint. Commit the public key with the app. Store the private PEM as the repository Actions secret `PULSE_UPDATE_PRIVATE_KEY`; never commit it, paste it in an issue, or upload it as an artifact. With authenticated GitHub CLI, a maintainer can provision it without printing the key:

```sh
gh secret set PULSE_UPDATE_PRIVATE_KEY --repo yuuma1on/yuu < /absolute/private/location/pulse-update-private.pem
```

Keep this key across releases. Existing apps trust their embedded public key. Replacing the public key requires a planned transition that first ships trust for the replacement through an update authenticated by the existing key.

## Publish a version

1. Set `package.json` and `package-lock.json` to the same new stable version, such as `1.26.1`. Commit the tested source and wait for the `main` Windows build to pass.
2. Create and push the matching tag, such as `v1.26.1`. The tag workflow validates the version, rebuilds, tests, installs, launches, signs, and publishes.
3. Alternatively, manually run **Windows build and release** with `publish` enabled and `release_tag` set to an existing matching tag. The default manual run only builds.

The release contains exactly:

- `PULSE-Setup-<version>-x64.exe`
- `PULSE-Setup-<version>-x64.exe.blockmap`
- `latest.yml`
- `pulse-update.json`

The workflow creates a draft with all four assets, checks the uploaded asset names, sizes, and states, and only then makes it public. An existing release is never overwritten. If publication fails, inspect the Actions logs and any remaining draft before rerunning; a maintainer must remove a failed draft first. Do not replace the installer in an already published version. Publish a higher version instead.

## Local signing and format

After `npm ci`, `npm test`, and `npm run build:win`, a maintainer can prepare the manifest locally:

```sh
node scripts/sign-update.mjs --dir dist --key /absolute/private/location/pulse-update-private.pem
```

The signer checks the stable package version, exact full NSIS installer name, `latest.yml` version, installer size and SHA-512 in both metadata entries, and private-key correspondence with the committed public key. It refuses extra installers, unexpected blockmaps, differential package metadata, and an existing `pulse-update.json`. It never prints the signing key.

`pulse-update.json` is a JSON envelope with exactly `payload` and `signature`. `payload` is Base64 of the exact UTF-8 JSON bytes; `signature` is Base64 of the Ed25519 signature over those bytes. The signed payload binds schema version `1`, app ID `app.pulse.rhythmstudio`, repository `yuuma1on/yuu`, stable channel, `win32` / `x64`, app version, publication timestamp, the exact GitHub installer URL/name/size/SHA-512, and the exact `latest.yml` name/size/SHA-512. Clients must verify the signature before trusting any payload field and must check all bindings and downloaded hashes before installation.

The Ed25519 signature authenticates updates to an installed PULSE app. The installer does not currently have an Authenticode publisher certificate, so Windows may display its usual unknown-publisher or SmartScreen prompt for a new download. Signing updates does not establish a Windows publisher identity.
