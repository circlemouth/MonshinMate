# LLM 通信仕様（2025-10 更新）

## デフォルトプロンプト
- **システム**: あなたは日本語で応答する熟練した医療問診支援AIです。患者の入力を理解し、医学的に適切で簡潔な回答や質問を行ってください。不要な前置きや断り書きは避け、常に敬体で表現してください。
- **追加質問生成**: 上記の患者回答を踏まえ、診療に必要な追加確認事項を最大 {max_questions} 件生成してください。各質問は丁寧な日本語の文章で記述し、文字列のみを要素とする JSON 配列として返してください。
- **サマリー生成**: あなたは医療記録作成の専門家です。以下の問診項目と回答をもとに、患者情報を正確かつ簡潔な日本語のサマリーにまとめてください。主訴と発症時期などの重要事項を冒頭に記載し、その後に関連情報を読みやすく整理してください。推測や不要な前置きは避け、医療従事者がすぐ理解できる表現を用いてください。

## プロバイダ別メモ

### Ollama
1. **JSON モード（簡易）**
   - リクエストボディで `format: "json"` を指定すると常に整形式の JSON が返る。
   - 応答は `response` フィールドの文字列として返るため、クライアント側で `json.loads` などのパースが必要。
   - プロンプトでも JSON 形式を明示する。

   ```bash
   curl http://localhost:11434/api/generate -d '{
     "model": "llama3.2",
     "prompt": "必ずJSONで回答してください。{\\"answer\\": string}",
     "format": "json",
     "stream": false
   }'
   ```

2. **構造化出力（推奨）**
   - `/api/chat` などで `format` に JSON Schema を渡すと、指定スキーマに準拠した JSON が返る。
   - JSON モードより堅牢で、公式ブログでも推奨されている。

   ```bash
   curl -X POST http://localhost:11434/api/chat \
     -H "Content-Type: application/json" \
     -d '{
       "model": "llama3.1",
       "messages": [{"role": "user", "content": "国情報をJSONで"}],
       "stream": false,
       "format": {
         "type": "object",
         "properties": {
           "name": {"type": "string"},
           "capital": {"type": "string"},
           "languages": {"type": "array", "items": {"type": "string"}}
         },
         "required": ["name","capital","languages"]
       }
     }'
   ```

### LM Studio（OpenAI 互換 API）
- `/v1/chat/completions` で `response_format: { "type": "json_schema", ... }` を指定すると JSON Schema に準拠した応答を強制できる。
- 応答は `choices[0].message.content` に文字列として格納されるため、クライアントでパースする。
- サーバ起動は Developer タブまたは `lms server start` を使用。

```bash
curl http://localhost:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-model",
    "messages": [
      {"role": "system", "content": "必ずJSONで出力"},
      {"role": "user", "content": "ジョークを1つ"}
    ],
    "response_format": {
      "type": "json_schema",
      "json_schema": {
        "name": "joke_response",
        "strict": "true",
        "schema": {
          "type": "object",
          "properties": { "joke": { "type": "string" } },
          "required": ["joke"]
        }
      }
    },
    "stream": false
  }'
```

## 運用メモ
- JSON Schema による構造化出力が最も堅牢（Ollama: `format`、LM Studio: `response_format.json_schema`）。
- 応答 JSON は文字列として返るため、バックエンドで必ずパースする。
- プロンプトでも「JSON 形式で回答する」旨を明示する。
- LM Studio は OpenAI 互換のため、既存の OpenAI クライアント設定をほぼ流用できる（非対応モデルがある点に注意）。
