# セキュリティレビュー・修正結果と本番反映前計画

## 最新状況：承認済み追加リリース

後続の明示承認により前段のパスワード保持移行・本番配備は完了済み（[実装履歴](<implementation.md>)、基盤固有の証跡は非公開文書）。さらに明示承認された残存型52件・npm6パッケージ指摘は0へ解消し、隔離検証・commit/push・2026-10-08 01:26 UTCのfrontendのみの本番反映まで完了。strictは維持し、backend/DB/現パスワード/鍵は変更していない。最新の結果・型宣言patch/実修正版overrideの理由・未検証範囲は [型・依存修正記録](<typecheck_dependency_remediation.md>) を参照する。以下の未配備表現や52件/6件の集計は、その時点の履歴であり最新の配備状態を示さない。

## 初回の結論と作業境界

公開Cloud Run/Firestore運用を前提に、公開リポジトリのコード・設定・ブラウザ側状態管理をレビューした。承認されたP0/P1と適用可能なP2を `security/security-review-hardening` ブランチで修正し、合成データだけの内部検証を完了した。

**外部APIの認証・応答契約が変わるため、本番反映前で停止した。本番デプロイ、設定変更、鍵交換、本番へのAPIリクエストは実施していない。** 続く依頼により `security/cloud-adapter-compatibility` ブランチで、すでにローカルに存在した非公開アダプタも修正・fake隔離検証した。ネットワークからの取得やsubmodule更新はしておらず、実クラウドの互換性・安全性を保証する段階ではない。

これはソースレビューと内部回帰検証の報告であり、侵害調査・本番ペネトレーションテスト・法令適合認証ではない。リポジトリ上の危険な設定が、実際の本番にも適用されていたと断定しない。

## 追加方針：パスワードのみ・現パスワード継続

ユーザーの明示指定を受け、`security/password-only-admin-migration` で `MONSHINMATE_ADMIN_REQUIRE_MFA=0` によるパスワードのみ運用へ対応する。未指定の本番は従来のMFA必須を維持。不正値・既存MFA・必須登録途中・ロック状態を迂回せず、共有レート制限・認可・失効・再認証は保持する。MFAなしはフィッシングやパスワード流出への追加要素を失う運用選択であり、MFAと同等の保護ではない。

現パスワードは、承認済みオフライン `migrate-legacy` で非初期・MFA無効の旧bcryptハッシュを未作成の新認証状態へ継承する。既定/不正/不明な状態・既存共有アカウントは上書きしない。実アカウントの適用可否や本番ログインは未確認。詳しくは [管理者セットアップ](<admin_system_setup.md>)。**本番デプロイや実DB移行は未実施**であり、以下の旧集計は前段の検証結果。

今回の隔離検証は backend **344 passed**、非公開adapter **52 passed**（fake Firestoreでhash継承→別instanceログイン→再認証→失効、既存レコード拒否、CAS競合を追加）、frontend **31 passed**・build成功。型検査は既存52件で前後診断差分ゼロ、cleanではない。npm既存6件（中2/高4）の脆弱性は残り、ブラウザE2E・実DB/SDK通信・本番起動は未検証。詳細と判断記録は [実装履歴](<implementation.md>)。

## 1. 主な指摘と対応

優先度はP0=公開前に必須、P1=医療情報/資格情報/整合性への重大な影響、P2=防御強化・運用品質の目安。

| 優先度 | 確認した問題領域 | 実施した修正 | 主な実装 |
|---|---|---|---|
| P0 | 管理・診断・データ操作APIの認可が個別実装で不統一 | 公開APIを明示許可し、それ以外は管理JWT必須。別ルーターにも同じ既定拒否を適用。自動API文書の公開停止 | [APIポリシー](../backend/app/api_policy.py)、[管理ルーター](../backend/app/admin_security_routes.py) |
| P0 | 初期/非常用パスワード、旧reset、パスワードと結び付かないMFA経路 | 旧経路410、オフライン単回資格情報、用途別短命トークン、MFA有効時password→challenge→TOTP。今回の指定は明示MFA任意 | [管理認証](../backend/app/admin_security.py)、[発行CLI](../backend/tools/provision_admin.py) |
| P1 | UUIDを知るだけで患者操作へ到達する境界、管理/連携権限との混同 | UUIDとは別の患者Bearer能力。サーバーはハッシュ保存、有効24時間。サマリー連携は専用ヘッダー | [患者セキュリティ](../backend/app/patient_security.py) |
| P1 | プロセス内だけの制限/失効状態、複数ワーカーの競合 | SQLite/CouchDB共有CAS。challenge/OTP/失効/レート/操作leaseを永続化。状態ストア障害は503 | [共有状態](../backend/app/security_state.py)、[DB契約](../backend/app/db/interfaces.py) |
| P1 | 確定後更新、重複確定、回答や要約の患者完了応答、再読込による質問状態消失 | 操作直前DB再読込、発行済み/未回答質問永続化、同期確定、不変化、再試行はreceiptのみ。上限0が5へ戻る不具合も修正 | [API実装](../backend/app/main.py)、[状態遷移](../backend/app/session_fsm.py) |
| P1 | 無制限の回答構造・本文・LLM利用 | 質問ID許可リスト、深さ/文字数/要素数上限、実受信本文サイズ制限、共有作成/LLMクォータ | [回答検証](../backend/app/validator.py)、[境界middleware](../backend/app/api_policy.py) |
| P1 | LLMへの不要な識別情報送信、自由な接続先、資格情報/生エラーの露出 | 臨床項目に限定、HTTPS完全origin許可リスト、redirect/proxy抑止、秘密値の除外、生例外ログ廃止。設定変更からの過去問診再送を廃止 | [臨床コンテキスト](../backend/app/clinical_context.py)、[LLMデータ制御](../backend/app/llm_data_security.py) |
| P1 | 能動コンテンツ画像、過大インポート/KDF、CSV数式、部分的設定置換 | ラスタ画像検証/再エンコード、固定KDFと容量上限、CSV無害化、SQLite原子インポート。他DB未対応は501で変更前に拒否 | [転送検証](../backend/app/transfer_security.py)、[原子インポート](../backend/app/sqlite_atomic_imports.py) |
| P1 | 共有端末の回答/資格情報残留、患者をまたぐ再送、ログアウト後の遅延副作用 | 完了/中止/アイドル消去、世代と患者能力に結び付いた再送、遅延成功/body/ダウンロード検証、画面離脱時abort。完了画面に医療情報を表示しない | [患者状態](../frontend/src/utils/patientSession.ts)、[管理通信](../frontend/src/utils/adminApi.ts)、[要求スコープ](../frontend/src/utils/requestScope.ts) |
| P1/P2 | build contextへの秘密/実データ混入、Composeの既定資格情報/公開ポート、未固定依存 | 秘密/DB/ログ/実画像/非公開アダプタの除外、loopback・必須鍵、汎用非rootコンテナ、Python/npmロック更新 | [除外設定](../.dockerignore)、[Compose](../docker-compose.yml)、[Pythonロック](../backend/requirements.lock)、[npmロック](../frontend/package-lock.json) |

加えて、管理JWTは15分・永続失効、機密操作は5分再認証、MFA変更中は旧MFAを維持、同一TOTPタイムステップ再利用拒否、汎用エラーレスポンス、Cache-Control/no-referrer/nosniff/frame制御を実装した。Nginxの子locationでCache-Controlを指定すると他ヘッダーの継承も消える点を修正した。

## 2. 外部接続の破壊的変更

詳細・正確な入出力は [API仕様](../docs/session_api.md)。旧クライアントと新サーバーの無計画な混在は禁止。

| 用途 | 新契約 | 移行時の注意 |
|---|---|---|
| 管理操作 | `Authorization: Bearer <admin access JWT>` | 任意・MFA未登録ならpassword→JWT。MFA有効時はchallengeとTOTPを順に実行。JWT900秒 |
| 初期登録/復旧 | オフラインCLIの単回資格情報→新パスワード→直接accessまたはMFA登録 | 旧固定パスワードを無効化。資格情報発行時点で既存アカウントをロック/失効 |
| MFA再登録/パスワード変更 | 管理Bearerに加えて `X-Admin-Reauth` | 再認証トークンは現在のJWTに結び付き300秒。パスワードは12文字以上・UTF-8で72バイト以下 |
| 患者回答/追加質問/確定 | 作成応答の `session_token` をBearerで送る | UUID単独不可。既存UUIDから能力を再発行するAPIなし。旧セッションの患者再開不可 |
| 患者確定 | `{id,status:"finalized",finalized_at}` のみ | 回答/氏名/要約を返さない。完了確認後にブラウザ側能力/回答を消去 |
| サマリー連携 | `X-MonshinMate-Api-Key` | 患者能力や管理JWTで代替不可。匿名サマリー取得は不可 |
| エクスポート/画像/設定/診断 | 原則管理Bearer | 旧リンク遷移/無認証ダウンロードを認証fetch→Blobへ変更 |
| インポート | SQLite原子処理、他の未対応DBは501 | 開いている患者能力・操作leaseがある置換は409。機密認証状態はポータブル出力に含めない |

旧 `POST /admin/init`、旧password reset/emergency、`GET /admin/totp/setup`、旧mode変更等は410。本番でMFAを無効化する経路は提供しない。

患者作成は60/IP/分・300全体/分、LLMは10/患者セッション/分・120全体/分、連携サマリーは30/IP/分・300全体/分。IPだけに依存せず共有の全体上限も設ける。信頼するproxy/IP復元は本番側で別途確認する。

## 3. 内部検証結果

### バックエンド

[隔離ランナー](../backend/tools/run_security_tests.py) が許可したソース/設定のみを一時コピーし、合成SQLite・ランダム鍵・空に近い環境変数で実行した。実DB、環境ファイル、実画像、監査ログ、非公開アダプタ、クラウド資格情報をテストへ渡していない。[Makefile](../Makefile) のtestも同ランナーに統一した。

```text
venv/bin/python backend/tools/run_security_tests.py -q
273 passed, 9 warnings in 43.19s
skip=0, xfail=0, exit=0
synthetic checkout: /tmp/monshinmate-security-tests-w1tvri_g
```

認証/MFA/bootstrap/recovery、CAS競合・再起動、異なる患者能力/失効/期限切れ、旧セッション拒否、確定再試行、保存後receipt障害の復旧、放棄lease非奪取、実受信サイズ/Content-Length偽装、臨床入力絞り込み、生資格情報のログ非出力、画像/ZIP/CSV/KDF/インポート原子性、Vertex境界、包装設定を含む。9件はPasslib、Pydantic、FastAPI/Starletteの非推奨警告で、未修正の将来互換課題。

### 非公開Cloud Runアダプタ追補

ローカルソースを先に修正してから、[接続サービス向け実装プロンプト](external_api_migration_prompt.md) を作成した。詳細は [非公開運用文書](../private/cloud-run-adapter/README.md) に限定する。

- CAS・患者状態・メタデータ・未対応インポート拒否と、起動／ビルド／secret注入の互換修正。
- 廃止管理パスワードの既定ロード、Firestoreヘルスチェックと追加質問失敗の生例外ログを除去。
- 独立レビュー後、CORS事前条件、LLM宛先設定の引継ぎ、明示リリース選択、費用制御のplan-only境界も修正。
- アダプタ専用のソースコピー隔離ランナー：**48 passed, 5 warnings, 2.05s, exit=0**。127通りのmockシェルシナリオを含む。合成テスト先は `/tmp/monshinmate-cloud-security-tests-klelwj81`。
- 全シェル構文検査成功。新規Python3.12仮想環境でベース38＋クラウド追加21固定依存のインストール、`pip check`、SDK importが成功。
- **実SDKトランザクション通信、Firestore emulator／実DB並行処理、実イメージbuild／起動、クラウド設定、追加クラウド依存の脆弱性監査は未検証**。fake／mock成功をこれらの代替としない。
- 非公開差分はローカルの変更前ソースからパッチ・ソース束・ハッシュ一覧として保全済み。保全成果物はGit管理・配布対象外とし、削除せずローカルに保持する。23ファイルの差分を変更前コピーへ適用し、24ソースの変更後バイト一致を検証。後続のコミット準備監査で、変更前ハッシュがある15ソースすべてが記録されたgitlinkの非公開コミットと一致することを確認した。配布には非公開側の正式ソースコミットとルートgitlinkへの反映が必要。

### フロントエンド

新ロックのソースのみ隔離コピーで `npm ci --ignore-scripts`、helper/境界回帰テスト、Vite7.3.7ビルドを実施。最終の遅延応答対策後も **26/26テスト成功、build成功**。テストには実行型helper検証と一部ソース契約検証が含まれる。

- 同じ依存・TypeScriptコンパイラで基準HEAD53診断→変更後52診断、新規診断0。
- **型検査全体は失敗しており、型検査成功とは報告しない。** 既存エラーの解消を別途必要とする。
- 実ブラウザE2E、実HTTPサーバー接続、実端末のキオスク/共有ブラウザ確認は未実施。
- 既存開発用node_modulesは変更していない。ロック採用後は `npm ci` が必要。

### 依存・設定

- Python3.12.3の新規仮想環境へ [requirements.lock](../backend/requirements.lock) の38パッケージをクリーンインストールし、`uv pip check` 成功。ロックは正確なバージョン固定だがハッシュ固定ではない。
- PythonのOSV照合は固定38パッケージを対象に再実施。残存は次節に明記。
- npm auditのpackage findingsは13→6へ減少（high4/moderate2）。**6種類の独立脆弱性という意味ではない**。
- 差分の空白検査成功。Docker/Nginxコンテナの実ビルド・実起動とOS層イメージスキャンは未実施。設定の静的テストはコンテナ検証の代替ではない。

## 4. 残存依存情報

「監査クリーン」ではない。現在のアプリ使用経路では該当条件に達しないと評価したものも、依存を更新・再評価する追跡対象として残す。

| 対象 | 残存情報と現在の評価 | 次の対応 |
|---|---|---|
| python-jose3.5.0 | [GHSA-3qf3-8w2g-rqmx](https://api.osv.dev/v1/vulns/GHSA-3qf3-8w2g-rqmx)。DER非対称鍵をHMACへ混用する条件。本実装はランダムな対称鍵と明示HS256許可リスト | 修正版/代替ライブラリを追跡。公開鍵をSECRET_KEYへ渡す設計変更は禁止 |
| ecdsa0.19.2 | [GHSA-wj6h-64fc-37mp](https://api.osv.dev/v1/vulns/GHSA-wj6h-64fc-37mp) / OSVのPYSEC-2026-1325。ECDSA署名/鍵生成等のサイドチャネル。本アプリJWTはHS256でECDSAを呼ばない | 暗号ライブラリの依存削減を評価。署名方式変更時に再評価 |
| Firebase経由のgrpc（4 package findings） | [GHSA-m9gg-hp2v-232j](https://github.com/advisories/GHSA-m9gg-hp2v-232j)、[GHSA-f596-whhp-79r4](https://github.com/advisories/GHSA-f596-whhp-79r4)。grpcサーバー認証/例外処理の条件。現フロントはFirebase app/messagingのみでFirestore/grpcサーバー未使用 | 上流更新を追跡。独立overrideは互換性評価後。リスクのあるFirebase大幅降格は行わない |
| React Router6.30.6（2 package findings） | [GHSA-wrjc-x8rr-h8h6](https://github.com/advisories/GHSA-wrjc-x8rr-h8h6)：未信頼遷移先、現行は固定内部path。[GHSA-337j-9hxr-rhxg](https://github.com/advisories/GHSA-337j-9hxr-rhxg)：SSR hydration、現行はcreateRoot/BrowserRouterで不使用 | Router7移行を別途テスト。外部入力をnavigate/Linkへ流す変更時に再評価 |

urllib3は2.8.0へ更新し、[proxy TLS](https://api.osv.dev/v1/vulns/GHSA-8988-9cw3-xx77)、[deflate停止](https://api.osv.dev/v1/vulns/GHSA-gh4c-6fx4-qh6g)、[chunk行メモリ](https://api.osv.dev/v1/vulns/GHSA-vxq7-64xx-v4gw) の該当バージョンから離脱。Router6.30.6で [GHSA-jjmj-jmhj-qwj2](https://github.com/advisories/GHSA-jjmj-jmhj-qwj2) に対応した。これらは照合時点の情報であり、新規advisoryの不存在を保証しない。

## 5. 本番反映前の必須ゲート（今回未実施）

以下は実行済み手順ではなく、別途承認を要する次段階の計画。GCP専用設定・実行手順は非公開アダプタ側へ置く。

### Gate A：非公開Firestoreとクラウド境界

1. ローカル非公開アダプタへのトランザクションCAS実装・fake検証は完了。権限のある担当者が非公開側の実revisionを確定してルートgitlinkへ反映し、実SDK／使い捨て検証DBで複数インスタンス間の一意消費・失効・lease・クォータを検証する。非公開リポジトリ内の変更はルートdiffだけでは配布できず、正式ソースコミットとgitlink更新を協調させる必要がある。
2. 追加質問metadata/未回答queue/完了状態の保存互換、原子インポート/能力失効の意味を確認。未対応インポートは501のままにし、部分処理で代替しない。
3. Secret Manager等からの `SECRET_KEY` / `TOTP_ENC_KEY` は**Pythonアプリimport前の環境注入**を確保する。後段の旧secretロードhookだけでは起動前検証に間に合わない。新規TOTP鍵で旧暗号文を読む運用は禁止。
4. IAM、Firestoreルール、サービスアカウント最小権限、外部入口、直接バックエンド到達性、信頼proxy、CORS origin、エッジ本文/タイムアウト/レート制限、ログ閲覧権限と保持期間を確認する。
5. productionイメージに鍵/DB/患者画像/内部資料がないこととOS層CVEを検証。リポジトリ中のPEM/旧拡張機能の資格情報扱いは実内容を読んでおらず、所有者による分類・露出評価が必要。自動で本番鍵を交換しない。

### Gate B：合成データの統合試験

- 複数Cloud Runインスタンス相当でbootstrap/OTP replay、失効即時反映、患者横断拒否、同時回答/確定、ストア障害503、保存直後の障害復旧を確認。
- Firestore/CouchDBの実サービス試験を別々に行う。今回のCouchDB検証はfake文書/リビジョンであり実サービス試験ではない。
- 実ブラウザでMFA、閉じたモーダルの遅延成功、ログアウト後JSON/Blob/ダウンロード、患者の切替/戻る/再読込/オフライン再送/15分警告と16分消去/複数タブを確認。
- TypeScript既存52診断を解消または正式に追跡・承認し、残存依存条件を再評価する。ブラウザE2E未実施のまま公開安全性を承認しない。

### Gate C：データ・クライアント移行

1. DB、既存TOTP暗号鍵、連携キーと設定を適切な秘密管理手段でバックアップし、合成/承認済み復元先で復元可能性を確認。
2. アクティブな患者フローの扱いを決める。旧セッションに新能力を後付け配布しない。旧患者は終了/中止して新フローへ移行し、既存記録は管理画面からのみ閲覧する。
3. 管理/患者/サマリー連携クライアントを新契約に合わせて同時切替する計画を作る。旧無認証経路を互換用に復活させない。
4. 管理者のオフライン発行→パスワード→MFA登録を保守時間帯に実施する計画を用意。発行そのものが既存アクセスを失効する点を周知する。
5. 本番反映・鍵交換・接続試験の具体的承認を得てから次段階へ進む。今回の変更をそのままデプロイしてはならない。

### Gate D：監視と復旧

- 401/409/429/503、CAS競合、放棄lease、LLM障害、外部送信先変更をPII抜きで監視。
- leaseは期限だけで自動奪取しない。プロセス停止・DB保存・LLM実行済み有無を運用者が照合し、再送で重複実行しない復旧手順を決める。
- ロールバックで旧無認証API・固定管理者パスワードを再公開しない。問題時は公開入口を閉じる/保守モード等の安全な復旧を計画する。

## 6. 明示的な残存制約

- 自由記述の個人情報は完全匿名化していない。LLM送信の同意、委託先の保持/学習/リージョン条件、院内運用基準は別途確認が必要。
- HTTPS完全origin制限はDNS pinningではない。許可originのDNS/運営主体の管理が必要。
- 一括削除は後続セッションの409等で一部のみ進む場合がある。インポートの原子性を一括削除まで拡張したとは主張しない。
- 取り込んだLLM設定は次回起動から有効。ランタイムへ即時反映せず、疎通や過去問診の再送を自動実行しない。
- 確定時のpush通知はbest effortで、exactly-once outboxではない。通知には氏名/回答を載せない。
- CSPはframe/base/objectの最小制御。完全なscript-src方針・HSTS・本番エッジヘッダーは未検証。
- readinessは公開詳細を除去したが、not_readyでも既存HTTP200契約。完全な依存健全性/SLO監視の代替ではない。
- 操作ログには不透明なセッションIDや件数が残る。全ての識別子を消したとは主張しない。
- 実データ・既存PEM・旧拡張機能の実利用状況、実クラウド設定、OSイメージ、ブラウザ内の既存配布物は今回未検証。

## 関連文書

- [API仕様](../docs/session_api.md)
- [管理者セットアップ](admin_system_setup.md)
- [管理画面マニュアル](../docs/admin_user_manual.md)
- [システム概要](system_overview.md)
- [実装履歴](implementation.md)
