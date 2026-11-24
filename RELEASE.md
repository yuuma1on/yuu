# Windows版の配信

配布先は公開リポジトリ`yuuma1on/yuu`です。公開するRelease資産は次の4ファイルだけです。

- `PULSE-Setup-<version>-x64.exe`
- `PULSE-Setup-<version>-x64.exe.blockmap`
- `latest.yml`
- `pulse-update.json`

初回配信作業ではGitHub Secrets APIが403を返し、`PULSE_UPDATE_PRIVATE_KEY`をCIに登録できていません。現在は、成功したWindowsビルドの資産をローカルで署名し、管理者がGitHub CLIで公開します。CI署名を有効にする前提は後述します。

## 更新の動作

自動更新はインストール済みのWindows x64版が対象です。起動から約10秒後と、その後6時間ごとに確認します。開発実行や他のOSでは利用できません。

現在は`electron-updater.quitAndInstall()`を使わず、`autoInstallOnAppQuit = false`にしています。独自のcontrollerが適用直前にも署名と実ファイルを再検証し、認証済みNSISをシェルや権限昇格なしで起動します。OSの`spawn`成功を待ってからmainがアプリを終了します。これはプロセスの起動確認であり、インストール完了の確認ではありません。

「再起動して更新」では更新後の起動を指定します。通常の終了時にも準備済み更新を確認して起動しますが、再起動は指定しません。通常終了時の検証・起動に失敗した場合は、更新せず終了を続けます。「終了すれば必ず更新が完了する」とは案内しないでください。

## 現在の手順：ローカル署名と公開

### 1. 同じソース・タグ・Windows資産を揃える

`package.json`と`package-lock.json`を同じ新しい安定版番号にし、レビュー済みmainへ反映します。**Windows build and release**のmainビルドで、テスト、NSISビルド、実インストール、インストール済みアプリの起動・デモ解析が成功したことを確認します。その同じコミットに`v<version>`のリモートタグを作成します。既存タグを書き換えてはいけません。

Secret未設定の間はタグpushによるCI配信が署名段階で停止するため、以下では成功したmainビルドの`pulse-unsigned-windows`資産を使います。署名端末も同じソースをcheckoutします。署名スクリプト自体はタグの由来を検証しません。次の例は同じBashセッションで順に実行します。実行IDと鍵保管先を実際の値へ置き換え、SHAを照合してください。

```bash
set -euo pipefail
pulse_repo='yuuma1on/yuu'
pulse_run='RUN_ID_OF_TESTED_MAIN_BUILD'
pulse_version=$(node -p "require('./package.json').version")
pulse_tag="v$pulse_version"
pulse_key='/absolute/private/location/update.private.pem'
pulse_dir=$(mktemp -d)

gh run view "$pulse_run" --repo "$pulse_repo" \
  --json headSha,headBranch,event,conclusion,jobs
test "$(gh run view "$pulse_run" --repo "$pulse_repo" --json headBranch --jq '.headBranch')" = main
test "$(gh run view "$pulse_run" --repo "$pulse_repo" --json conclusion --jq '.conclusion')" = success
pulse_build_sha=$(gh run view "$pulse_run" --repo "$pulse_repo" --json headSha --jq '.headSha')
test "$(git rev-parse HEAD)" = "$pulse_build_sha"
test "$(gh api "repos/$pulse_repo/commits/$pulse_tag" --jq '.sha')" = "$pulse_build_sha"
```

対象のmain実行で必要なWindowsジョブが成功していることも確認します。未コミットのソース変更や、別コミットの資産を混ぜた状態では署名しません。

### 2. 既存の秘密鍵で署名する

初回の鍵ペアは作成済みです。`desktop/update-public-key.pem`に対応する既存鍵を使い、403への対処として鍵を作り直しません。秘密鍵はリポジトリ外に置き、バックアップも非公開・アクセス制限付きで保管します。内容を画面やログへ表示したり、Issue、Actions資産、配布物へ貼り付けたりしません。

固定ロックから署名用依存関係を導入し、同じビルドの3資産を空ディレクトリへ取得します。`--key`と環境変数`PULSE_UPDATE_PRIVATE_KEY`は併用できません。

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --ignore-scripts
gh run download "$pulse_run" --repo "$pulse_repo" \
  --name pulse-unsigned-windows --dir "$pulse_dir"

test -s "$pulse_dir/PULSE-Setup-$pulse_version-x64.exe.blockmap"
test ! -L "$pulse_dir/PULSE-Setup-$pulse_version-x64.exe.blockmap"
node scripts/sign-update.mjs --dir "$pulse_dir" \
  --version "$pulse_version" --key "$pulse_key"
```

スクリプトは、安定版番号、期待する唯一のx64フルNSIS、`latest.yml`の版・名前・サイズ・両方のSHA-512記載、秘密鍵と公開鍵の一致を検証して`pulse-update.json`を作ります。既存manifestは上書きしません。blockmapの内容・ハッシュを署名する処理ではないため、同じ成功ビルドのblockmapを別途揃えます。

署名後はインストーラーや`latest.yml`を書き換えません。失敗した作業ディレクトリは内容と原因を確認し、準備し直す際は新しい空ディレクトリを使います。

### 3. draftへ4ファイルだけ追加して公開する

既存Releaseがあれば停止して確認します。公開済みの版は上書きせず、失敗したdraftの扱いも管理者が別途確認します。自動削除や`--clobber`は使いません。

```bash
gh release create "$pulse_tag" --repo "$pulse_repo" --verify-tag \
  --draft --title "PULSE $pulse_version" --generate-notes
gh release upload "$pulse_tag" --repo "$pulse_repo" \
  "$pulse_dir/PULSE-Setup-$pulse_version-x64.exe" \
  "$pulse_dir/PULSE-Setup-$pulse_version-x64.exe.blockmap" \
  "$pulse_dir/latest.yml" "$pulse_dir/pulse-update.json"
gh release view "$pulse_tag" --repo "$pulse_repo" --json assets \
  > "$pulse_dir/uploaded-assets.json"
```

ワイルドカードやディレクトリ一式はアップロードしません。秘密鍵・バックアップは含めません。公開前に資産の名前・個数・サイズ・アップロード完了状態を確認します。

```bash
PULSE_RELEASE_DIR="$pulse_dir" PULSE_RELEASE_VERSION="$pulse_version" \
node --input-type=module <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.PULSE_RELEASE_DIR;
const installer = `PULSE-Setup-${process.env.PULSE_RELEASE_VERSION}-x64.exe`;
const names = [installer, `${installer}.blockmap`, 'latest.yml', 'pulse-update.json'];
const { assets } = JSON.parse(fs.readFileSync(path.join(dir, 'uploaded-assets.json'), 'utf8'));
if (assets.length !== names.length) throw new Error('Release資産は4ファイルだけにしてください。');
for (const name of names) {
  const local = fs.lstatSync(path.join(dir, name));
  const remote = assets.find(asset => asset.name === name);
  if (!local.isFile() || local.isSymbolicLink() || local.size <= 0 ||
      !remote || remote.size !== local.size || remote.state !== 'uploaded') {
    throw new Error(`資産を確認できません: ${name}`);
  }
}
console.log('4ファイルの名前・サイズ・アップロード状態を確認しました。');
JS

gh release edit "$pulse_tag" --repo "$pulse_repo" --draft=false --latest
```

最後の公開コマンドは確認が成功してから実行します。不完全なdraftは公開せず、公開後の修正は番号を上げた新しいReleaseとして配信します。

## 現在のGitHub接続で公開する場合

この接続ではActions資産のAzure保管先が通信拒否され、`uploads.github.com`への直接追加も401になりました。上記の直接アップロード手順は、Release資産を書き込める資格情報を持つ管理者向けです。この接続では、次の2つのworkflowを使います。

1. **Stage tested assets in a release draft**へ成功したmainの`run_id`と`version`を渡します。検証済みの3資産をGitHub内でdraftへ移し、公開は行いません。
2. `gh release download`でdraftの3資産を取得し、同じテスト済みソースと既存秘密鍵でローカル署名します。
3. 作成した公開可能な`pulse-update.json`の正確なバイト列を`release-manifests/v<version>.json`へ、説明文を`release-manifests/v<version>-notes.txt`へ保存し、mainへコミットします。秘密鍵はコピーしません。
4. **Publish an authenticated tested release**へ同じ`run_id`と`version`を渡します。workflowがdraftの元コミット、署名・全ファイルのハッシュ、4資産の内容を照合し、署名済みmanifestの追加後に公開します。ビルドのやり直しや既存資産の上書きは行いません。

この手順でGitHubへ送るのは公開用署名だけです。CIへ秘密鍵を登録せずに、利用者向けの自動更新を配信できます。

## 将来CI署名を有効にする所有者の作業

現workflowはビルド、署名、公開を分離しています。署名ジョブは新しいrunnerで`npm ci --ignore-scripts`を使い、鍵を署名コマンドだけへ渡します。公開ジョブだけが`contents: write`を持ちます。

workflowは署名ジョブを`release-signing`環境へ紐づけ、リリースコミットがmainの祖先であることをビルド時に`git merge-base`、公開時にGitHub APIで再確認します。**GitHub側の環境保護・承認者・main/tag保護やSecret登録は、これらのコードでは設定されません**。Secret登録前に、正規の権限を持つ所有者が次を整えます。

1. main、workflow、署名スクリプト、依存ロックをレビューし、mainの保護と必須チェック、承認済みコミットからのリリースタグだけを許す強制ルールを設定します。祖先確認だけで、mainやタグの作成権限・変更内容の承認まで保証されるわけではありません。
2. workflowの指定と同名の`release-signing`環境を設定し、必要な承認者と承認済みrefの制限を付けます。未信頼ブランチ、PR、任意タグから鍵へ到達できないことを確認します。環境が自動作成されても保護や承認者が自動で付くわけではなく、このGitHub側の設定は未完了です。
3. その後、秘密鍵を**環境スコープ**の`PULSE_UPDATE_PRIVATE_KEY`へ登録します。広いリポジトリSecretへ先に入れて代用しません。所有者の権限でGitHubの環境設定を使うか、次を実行します。

```bash
gh secret set PULSE_UPDATE_PRIVATE_KEY --repo yuuma1on/yuu \
  --env release-signing < /absolute/private/location/update.private.pem
```

403が続く場合は所有者が権限・ポリシーを確認し、CI署名を有効にせずローカル署名を続けます。認証制限を回避する処理や、鍵の公開による代用はしません。

設定後は対応する安定版タグのpush、または**Windows build and release**の手動実行で`publish=true`と既存`release_tag`を指定して配信できます。通常のmain pushと手動実行の既定値はビルドのみです。公開ジョブもdraftの4資産を確認してから公開し、既存Releaseを上書きしません。

既存アプリは同梱公開鍵を信頼しています。鍵を変更する場合は、旧鍵で認証できる更新を通じた計画的な移行が必要です。非公開バックアップを保ち、紛失・漏えい時に単純に新鍵へ差し替えないでください。

## 公開後のWindows更新確認

通常ビルドのsmokeは新規インストール・起動・デモ解析の確認です。旧版から新版への更新完了を証明するものではありません。

公開したstable/latest版に対して、別の**Authenticated Windows update E2E**を実行できます。`target_version`を公開版、`baseline_version`をそれより低い使い捨て版に指定します。`scripts/windows-update-e2e.ps1`は公開フィードの署名・メタデータを検証し、実際のインストール済み旧版から更新を起動して新版を確認します。確認用の旧版は公開しません。結果が成功する前に、更新経路を検証済みとは案内しません。

## 署名形式とWindowsの発行元表示

`pulse-update.json`は`payload`と`signature`だけを持つJSONです。payloadはUTF-8 JSONの正確なバイト列をBase64化したもの、signatureはそのバイト列のEd25519署名です。アプリID、リポジトリ、stable、Windows x64、版、公開時刻、インストーラーのURL・名前・サイズ・SHA-512と、`latest.yml`の名前・サイズ・SHA-512を結びつけます。クライアントは署名を検証してから内容を信頼し、実ファイルも照合します。

この署名はPULSE内で更新元を認証するものです。WindowsのAuthenticode発行元証明書は現在設定していないため、初回ダウンロード・実行時にWindowsの警告が出る場合があります。更新署名を付けてもWindowsの発行元証明にはなりません。
