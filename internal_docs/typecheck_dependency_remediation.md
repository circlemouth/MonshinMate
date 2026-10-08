# 型検査・npm依存指摘の解消

## 作業境界

ユーザーの追加承認により、残存TypeScript52診断とnpm監査6パッケージ指摘を修正し、commit/push・本番frontend反映まで進める。API契約、backendの配備・Python依存、パスワードのみ認証、認証DB・秘密鍵は変更しない。前段のOTP解除・管理者移行を再実行しない。実パスワード・実患者・実通知資格情報をテスト入力にしない。

## 基準の再現

元版 `1c02c86` のlockを使うソースのみの一時コピーで `npm ci`、既存32試験、Vite buildが成功したが、`tsc --noEmit` は52診断でexit2、`npm audit` は6パッケージ（high4/moderate2）でexit1。6件は独立した6種類の脆弱性を意味しない。

- Firebase12.17.1から未使用Firestoreの依存として入るgrpc-js1.9系により、firebase/firestore/firestore-compat/grpc-jsの計4high。公式Firebase13へ単純更新しても調査時点ではgrpc制約が残り、Node要件も上がる。公式に非推奨の内部サブパッケージ直接利用や古いFirebaseへの強制ダウングレードはしない。
- React Router6.30.6のrouter/dom計2moderate。修正版は7系であり、React18・Node20との互換性と宣言的ルーティングを検証して更新する。

照合したadvisory: [gRPC証明書認証](https://github.com/advisories/GHSA-m9gg-hp2v-232j)、[gRPC例外メッセージ](https://github.com/advisories/GHSA-f596-whhp-79r4) は1.13.6/1.14.5が修正版。[Router外部redirect](https://github.com/advisories/GHSA-wrjc-x8rr-h8h6)、[Router SSR constructor injection](https://github.com/advisories/GHSA-337j-9hxr-rhxg) は7.18.0以降が修正版。後者は上流が宣言的モードを非影響とするが、監査指摘は除外せず依存自体を更新する。

## 修正と検証（完了）

- [x] strictを維持したBundler解決・default import互換。StatusBannerのtitle衝突、FollowupStateのscope、テンプレートIDのunknown境界、uploadのnull失敗契約、個人情報inputMode、拡張テーマ型を修正。
- [x] Chakra2.10.10でもtheme26診断は残り、theme旧3.4.6でも再現。theme3.4.10の11 type-literal scopeのindex signatureに、それぞれのoptional propertyが明示するundefinedを追加する型宣言のみの限定patchを適用。対象版・元/適用後SHA256・11変換を固定し、未知内容は失敗。186 packageファイル比較で変更はdist/types/index.d.tsのみ、runtime JavaScriptは不変。idempotenceと本当の型エラーが引き続き診断される回帰を追加。skipLibCheck/ts-ignore/strict無効化は不使用。ChakraのonBeforeInput宣言互換にはReact18型18.3.20 exact pin、tinycolor型を追加、framer11.18.2へ更新。
- [x] 公式Firebase12.17.1とReact/ReactDOM18.3.1 runtimeを維持。間接grpc-jsを同majorの実修正版1.13.6へoverrideし、lock/実install全コピーとも1件・1.13.6に一致。Node engineは既存Node20条件と適合し、実Node20 builderでpostinstall＋strict typecheckを含むCloud Buildが成功した。公式Firebaseのoffline import、Firestoreが使用するprotobuf/Metadata/client options/unary/server-stream API、合成CAの信頼成功/別CA拒否、thrown errorの合成秘密文字列redactionの4試験成功。1.13系にgetAuthContext自体がなく同関数の直接試験ではない。overrideは監査除外ではなく実際の依存更新。
- [x] strict型検査・直接tscとも0、npm audit全深刻度0、標準43/43試験とVite build成功。sourceのみの79ファイルSHA256が隔離コピーと一致、manifest/lock一致・npm ci後lock不変。独立レビューでも型/43試験とReact18/Chakra2/Router7/framer11の合成SSR、実Appルートのlogin/basic-info、患者guard/世代確認成功（DOM/E2Eではない）。production build前に型検査を必須化し、Dockerではpostinstall scriptをnpm ci前にCOPYする。実nginxのnetwork-none/host portなし1試験成功。private allowlistの隔離171 passed/4既存skip。画像upload失敗/null時には旧画像を消さずgeneric通知する順序へ修正。URI許可リストや画像保存全体のtransaction化を追加したという意味ではない。
- [x] 実装source commit `98cb1694b7bd08248b808387e4b00b8830c5661b` とprivate変更を `release/typecheck-dependency-remediation` へcommit/push。追加差分の秘密値パターンスキャンで未説明指摘0（privateの既存invalid-domain資格情報拒否fixture1件は合成例と分類）、実env/DB/患者assetは追加せず。clean sourceからCloud Build成功、Node20 builderのnpm ci/postinstall/strict typecheck/buildを通過。後続の文書追補commitはbuilt sourceを変更しない。
- [x] **2026-10-08 01:26 UTC、本番frontend更新完了。** immutable digestのno-traffic候補で既存traffic不変・readiness200・password-only公開状態・無認証管理API401を確認。candidate配信JSのSHA256が隔離ビルドと完全一致し、Chrome ForCodexでloginを表示確認後、frontend canonical100%と全4tagを同一固定revision（latest=false）へ切替。canonical/tag/custom domainのfrontend6 URLすべてで同じcompiled JS・GET/HEAD login200/no-store/DENY・same-origin設定を確認。backend4 URLのreadiness/認証境界、既存revision/digest/traffic hash不変も確認。Chromeでcustom domainのlogin表示・画面を確認、実passwordを入力しない。基盤固有の識別子は非公開配備記録に保存。

## 再現・保守

ソースのみを隔離コピーし、合成設定とNode `^20.19.0 || >=22.12.0` で `npm ci` → `npm run typecheck` → `npm test` → `npm run build` → `npx --no-install tsc --noEmit`、`npm audit --json` を実行する。既存node_modulesではlock更新が自動反映されない。型修復postinstallはTypeScript devDependencyが必須で、`npm ci --omit=dev` や未知のtheme版/hashでの無条件patchはサポートしない。次の依存更新時はpin/override/宣言patchを再評価し、上流修正版なら限定patchを外す。buildのgateを外さない。

## 残存制約

Viteのruntime config.js非module警告とmain chunk約674kB（500kB超）の既存警告は残し、抑制していない。画像交換のupload失敗保護は追加したが、未保存画像の全transaction/削除失敗/同時選択の完全整合性までは修正対象外。SSRはDOM effects/history/Framer animationや全ブラウザE2Eの証明ではない。

`npm audit` の0件は照会時点の登録済みnpm advisoryを対象とする。OSイメージやPython依存の監査、未発見脆弱性、実資格情報による全機能・push通知・実患者フロー成功を証明しない。旧認証版には戻さず、復帰が必要なら今回更新前の互換frontend固定版に限って運用判断する。前段バックアップは保持するが、今回は認証/DB移行や新たなDB復元を行わない。
