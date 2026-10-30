# 問診完了画面がトップへ戻る現象の調査（2026-10-30）

> 以下は修正前の調査記録。後続の明示承認による修正・配備の現在状態は [実装履歴](<implementation.md>) を参照。

## 結論と確認範囲

- ローカルの現行ソース `4bb31c6` と正規lockの依存で、完了成功後に `/done` への遷移が `/` で上書きされる不具合を隔離ブラウザで再現した。
- 原因は、確定成功に伴う患者状態の消去が、現在表示中の患者ルートのガードを再描画させ、正常完了を「アクセス条件を満たさない状態」としてトップへ戻す競合。
- 完了メッセージを非表示にする設定や、自動的にトップへ戻す完了画面タイマーではない。完了コンポーネントの存在確認だけでは実際の遷移成立を保証できなかった。
- 本番環境・実DB・実患者データ・環境ファイル・秘密情報・非公開サブモジュールにはアクセスしていない。本番配備版との一致と個々の発生事象の直接照合は未確認。
- アプリケーションの修正、commit/push、本番反映は未実施。本変更は調査文書のみ。

## 原因の経路

1. 各患者ページは `await finalizePatient(sessionId)` の完了後に `navigate('/done', { replace: true })` を呼ぶ。
2. `finalizePatient()` は未送信回答を確認し、確定応答を取得して `acknowledgeFinalization()` へ渡す。
3. ID・状態・確定時刻が妥当なら、`acknowledgeFinalization()` はその場で `clearPatientSession()` を呼ぶ。
4. 消去処理はtoken・回答・受診種別等を消し、世代更新と進行中fetchのabort後に `patientSessionCleared` を同期発火する。
5. `PatientGuard` はこのイベントで通常優先度のstate更新を予約する。再描画時には受診種別・セッションが消えているため `<Navigate to="/" replace />` を返す。
6. 正規lockのReact 18.3.1 / React Router 7.18.4では、`BrowserRouter` の遷移state更新は既定で `React.startTransition()` 内にある。ガードの通常更新が先に処理され、ガードのトップ遷移が完了遷移を上書きできる。

参照:

- [確定と消去](<../frontend/src/utils/finalizePatient.ts#L5-L14>)
- [患者状態の消去・イベント](<../frontend/src/utils/patientSession.ts#L27-L33>)、[確定応答検証](<../frontend/src/utils/patientSession.ts#L83-L88>)
- [ガードのイベント購読・トップ遷移](<../frontend/src/components/PatientSafety.tsx#L9-L17>)
- [ルート構成](<../frontend/src/App.tsx#L227-L231>)、[BrowserRouter](<../frontend/src/main.tsx#L18-L26>)
- [問診のみ](<../frontend/src/pages/QuestionnaireForm.tsx#L201-L214>)、[追加質問](<../frontend/src/pages/Questions.tsx#L22-L35>)、[質問要否判定](<../frontend/src/pages/LlmWait.tsx#L15-L28>)

## 隔離再現

Gitのソース・テスト・package/lock・必要な静的設定だけを一時ディレクトリへ展開し、`npm ci` で依存を導入した。既存node_modules・環境ファイル・実DBは利用していない。検証専用の起動入口でAPIを合成応答に置き換え、元のApp・患者ページ・ガード・確定helperを変更せず実行した。合成セッション、空の合成テンプレート、合成追加質問のみを使用し、外部fetchは禁止した。配信先はloopbackのみ。

公式ForCodex接続のブラウザで以下を確認した。

| 経路 | 合成APIの確定 | 観測された履歴変更 | 最終表示 |
| --- | --- | --- | --- |
| 追加質問を無効にした問診の「次へ」 | 成功応答 | `/questionnaire` → `/done` → `/` | トップ |
| 合成追加質問の「まとめて送信」 | 成功応答 | `/questions` → `/done` → `/` | トップ |
| 追加質問なしの要否判定 | 成功応答 | `/llm-wait` → `/done` → `/` | トップ |

各経路で `/done` と `/` の履歴更新間隔は約0.6〜0.7ms。DOM監視では完了メッセージの描画は観測されず、最終的に患者状態はすべて消去されていた。表示時間は実行時のスケジューリングに依存するため、「一瞬見える」ことまで同一に再現したとは主張しない。確定応答はmockであり、本番の保存成功を検証したものではない。

## テスト結果・限界

- 正規lockによる隔離frontend標準テスト: **43 passed / 0 failed**。
- 同隔離コピーのstrict型検査: **成功**。
- 同隔離コピーのproduction build: **成功**。500kB超chunkの警告あり。
- 実ブラウザでの再現は**Vite開発モード**。production build後のブラウザ検証は、公式接続が操作結果不明として追加操作をブロックしたため未実施。別プロファイル・別ブラウザ等で迂回していない。開発用StrictModeでは要否判定APIが重複したが、問診ボタン経路でも同じトップ遷移を確認した。
- 最初のoffline installはcache不足で失敗し、通常のlock固定installで解消。初回標準試験の2失敗は隔離コピーの [Nginx設定](<../frontend/nginx.conf.template>) / [Dockerfile](<../frontend/Dockerfile>) 不足であり、必要な静的設定を追加した後の再実行で全件成功した。アプリ・既存試験の変更による回避はしていない。
- backend pytest・実SDK・実クラウド・本番ブラウザ・実患者テストは未実施。ローカル調査用サーバーは終了した。

既存試験は、確定応答後の消去、消去後のルート拒否、確定成功後の完了遷移コードを**個別に**検査している。しかし、実際にルーターとガードを同時に動かして「正常完了後は完了画面に留まる」ことを検査していないため、今回の競合でも全件成功する。

- [個別helper試験](<../frontend/tests/security.test.cjs#L381-L392>)
- [消去後のアクセス拒否](<../frontend/tests/security.test.cjs#L411-L420>)
- [ソースの遷移順序検査](<../frontend/tests/security.test.cjs#L439-L448>)

## 修正方針と残作業

- [ ] 正常完了と、中止・期限切れ・別患者開始による消去を区別し、正常完了時の消去と完了遷移がガードのトップ遷移に負けないよう整合させる。各ページの「セッションなし」のeffectも含めて検証する。具体的な実装は未選定・未検証。
- [ ] ガードそのものの削除、tokenや回答の保持、単なる遅延タイマー追加、Router全体のスケジューリング変更を安易な回避策にしない。
- [ ] 3経路それぞれで成功後に `/done` と完了文言が維持される統合回帰を追加する。確定失敗では回答を保持して再試行できること、戻る操作で入力が復活しないこと、中止・アイドル・別患者開始で保護が維持されることも確認する。
- [ ] production artifactのブラウザ検証と本番配備版の確認は別途実施。本番アクセス・変更には明示的な許可が必要。

## 後続修正の回帰試験

修正後は [オフライン回帰](<../frontend/tests/patient-completion.test.cjs>) を標準 `npm test` に追加した。実helper/TSXを使うがReact hookとNavigateをmockするため、Routerの優先度を再現するE2Eとは区別する。

実React/BrowserRouter/Appの回帰は [ブラウザfixture](<../frontend/tests/patient-completion.browser.tsx>) と [ビルドスクリプト](<../frontend/tests/build-patient-browser.mjs>) を使用する。**環境ファイルなしの隔離コピーからのみ** `npm ci` → `npm run test:browser:build` を実行し、生成した `patient-browser-dist` をloopback限定でpreview配信して公式接続のブラウザで「統合回帰を実行」を押す。fixtureは同一originのAPIもすべて合成応答に置換し、外部fetchを拒否する。production通常ビルドとテストビルドは別成果物であり、fixture・合成資格情報・生成物は本番アップロードallowlistに含まれない。公開用文書スナップショットは生成しない。

修正後の隔離検証では標準59試験、strict型検査、production buildが成功し、ブラウザ11項目がproductionと開発StrictModeの双方で成功した。配備実績・未検証範囲の現在状態は [実装履歴](<implementation.md>) を参照する。
