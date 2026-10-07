# AGENTS

## 1. 文書の目的
- MonshinMate（問診メイト）の複数エージェント開発を、安全・一貫性・再現性を優先して進める。
- 現行仕様は [システム概要](internal_docs/system_overview.md)、[API仕様](docs/session_api.md)、[管理者セットアップ](internal_docs/admin_system_setup.md) を優先する。
- [実装履歴](internal_docs/implementation.md) は判断メモ、[初期計画](internal_docs/plannedSystem.md) と [初期設計](internal_docs/PlannedDesign.md) はアーカイブ。[LLM接続資料](internal_docs/LLMcommunication.md) の古いコマンドより現行概要を優先する。

## 2. コミュニケーション
- 回答・報告は日本語。曖昧な要件は事前確認し、前提と選択肢を明記する。
- 検証済み事実、推測、未検証事項を区別する。本番環境の変更・アクセスは別途明示的な許可が必要。
- セキュリティ修正は外部APIの接続方法を変更している。今回の作業範囲はコード修正と隔離内部検証まで。本番デプロイ・鍵交換・実患者によるテストは行わない。

## 3. システム構成
- [FastAPI](backend/app/main.py)、[DBファサード](backend/app/db/__init__.py) とSQLite/CouchDBアダプタ、[LLMゲートウェイ](backend/app/llm_gateway.py)、React/Vite/Chakra UIで構成する。
- 通常の既定はSQLite。CouchDB明示設定時はセッションと共有セキュリティ状態を永続化し、障害時にSQLiteやメモリへ黙ってフォールバックしない。
- 管理者JWT・患者能力トークン・サマリー連携キーは相互代替不可。新規APIは既定で管理者限定。
- LLM入力は臨床項目に限定するが、自由記述の完全匿名化を保証しない。設定更新やインポートで過去の問診を自動再送しない。
- PDF/CSV/Markdown/ZIP、画像、設定、問診データの管理操作にもサーバー側認証が必要。公開表示用APIと診断・管理APIを混同しない。

## 4. GCP関連コンテンツの配置
- Cloud Run/Firestoreのデプロイ設定・スクリプトは非公開サブモジュール `private/cloud-run-adapter` 側で管理する。ルートには最小限の参照だけを置く。
- [バックエンドDockerfile](backend/Dockerfile) は汎用SQLite/CouchDB用。GCP依存を同梱しない。
- ローカルの非公開Firestore実装へCAS・患者状態保護・メタデータ保存・未対応インポート501を追加し、fakeで隔離検証済み。実SDK通信・実DB並行処理・クラウド起動は未検証。[アダプタ運用文書](private/cloud-run-adapter/README.md) のリリースゲートを満たすまで本番へ反映しない。サブモジュールを無断取得・更新しない。

## 5. 開発環境
- 検証済みPythonは3.12。依存は [requirements.lock](backend/requirements.lock) で固定する。仮想環境を使い、共有環境へグローバルインストールしない。
- Node.jsは `^20.19.0 || >=22.12.0`。npmと [package-lock.json](frontend/package-lock.json) を正規管理とし、`npm ci` を使う。古いnode_modulesはロック更新を自動反映しない。
- 起動は明示した合成DBと開発用設定で行う。既定DB・実環境の環境ファイル・秘密鍵・患者画像・監査ログを開発/テスト入力にしない。
- Python依存の例（リポジトリルートから）:

```bash
python3.12 -m venv venv
venv/bin/python -m pip install -r backend/requirements.lock
venv/bin/python -m pip install --no-deps -e backend
# テスト用ツールは同じ仮想環境へ追加
venv/bin/python -m pip install pytest httpx
```

- Vite開発サーバーは既定でloopbackのみ。[Vite設定](frontend/vite.config.ts) のプロキシ契約と [Nginx設定](frontend/nginx.conf.template) を同時に維持する。
- [Compose](docker-compose.yml) は全ホストポートを127.0.0.1に限定。CouchDB資格情報と `SECRET_KEY` / `TOTP_ENC_KEY` は必須で、`admin/admin` 等の既定認証はない。汎用Composeを本番Cloud Runの設定だとみなさない。

## 6. 作業プロセス
- 開始前に現行ドキュメントを確認し、新規作業はブランチを分ける。Issueがある場合はブランチ/コミットに番号を含める。
- 実装履歴へチェックボックス付きで判断・進捗・未解決事項を追記する。仕様変更は該当する現行仕様書も更新し、差分を報告する。
- 並行作業のファイル所有範囲を決め、他担当の変更を上書きしない。

## 7. コード品質
- Python型ヒント、既存UI構成、読みやすさを維持し、複雑な処理には短いコメントを付ける。状態管理の大幅変更は事前相談する。
- UIだけでなくサーバー側権限・保存・失効・同時実行の整合性を検証する。FastAPI/Pydanticの400/401/403/409/413/422/429/503を明確に区別する。
- ログへ患者回答、氏名、資格情報、プロバイダ応答の生エラーを出さない。

## 8. テスト
- **実チェックアウトでpytestを直接実行しない**。既存fixtureには破壊的なDB初期化があるため、[隔離ランナー](backend/tools/run_security_tests.py) でソースのみを一時コピーし、合成DB・合成キーを使う。

```bash
venv/bin/python backend/tools/run_security_tests.py -q
# frontendは.envを含まない隔離ソースコピーで実行
npm ci
npm test
npm run build
npx tsc --noEmit
```

- Viteビルド成功は型検査成功ではない。既存TypeScriptエラーがある場合、同一依存/コンパイラで基準版と差分比較し、新規エラーと既存エラーを分けて報告する。
- 利用可能なら隔離環境でブラウザE2Eを行い、患者作成→回答→確定→消去、MFAログイン→管理操作を検証する。ブラウザ環境がない場合はAPIフローとhelper回帰テストで代替し、未実施と明記する。
- CouchDB/Firestoreを検証するときも使い捨ての承認済み環境に限定する。fake adapterテストを実サービス検証と呼ばない。

## 9. 認証・データ取扱い
- 固定の初期管理者パスワード、`ADMIN_PASSWORD`、`ADMIN_EMERGENCY_RESET_PASSWORD` による認証は廃止。[provision_admin.py](backend/tools/provision_admin.py) で対象を明示し短命・単回のbootstrap/recovery資格情報を発行する。
- 発行は既存管理者を即座にロック・失効するため、運用承認・保守計画・DBと既存TOTP鍵のバックアップを先行させる。旧usersを自動信頼しない。
- ユーザー指定のパスワードのみ運用は `MONSHINMATE_ADMIN_REQUIRE_MFA=0` を明示する。未指定の本番はMFA必須を維持し、不正値は拒否。既存MFA・必須登録途中・ロックを設定だけで迂回しない。パスワード変更でMFAを無効化しない。
- 現パスワードの継続は、承認済みオフライン `migrate-legacy` で旧adminの非初期bcryptハッシュを未作成の共有認証状態へ一度だけ移す。自動移行・平文環境変数fallback・既存状態上書きは禁止。TOTP鍵を盲目的に置換しない。
- 患者トークンはURLやログへ入れない。共有端末では完了・中止・アイドルで回答/資格情報/再送キューを消し、遅延応答が次の患者へ混入しないよう世代を検証する。
- 開発・テストは合成患者のみ。実データの照合・ログ閲覧は明示された許可と規程に従う。

## 10. ドキュメントと納品
- [管理マニュアル](docs/admin_user_manual.md)、[API仕様](docs/session_api.md)、内部文書の矛盾を残さない。公開スナップショットの生成は依頼された場合のみ実施する。
- [ ] Why/How、破壊的API変更、移行手順を説明できる。
- [ ] 隔離バックエンドテスト・フロントテスト・ビルド結果を報告した。
- [ ] 型検査、ブラウザ、実DB/クラウド検証の未実施や残存脆弱性を明記した。
- [ ] 実装履歴と仕様を更新し、本番反映前のゲートを明記した。
- [ ] 日本語で変更・既知の制約・残作業を報告した。
