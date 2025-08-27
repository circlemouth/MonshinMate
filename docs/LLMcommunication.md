

Ollama

1) JSONモード（簡易・公式サポート）
	•	指定方法: リクエストボディで format: "json" を指定
	•	挙動: 「常に整形式のJSON」が返る旨が明記。response フィールドにJSON文字列として入るため、受側で JSON.parse 等が必要。プロンプトでもJSONで答える旨を明示するのが推奨。  ￼

curl http://localhost:11434/api/generate -d '{
  "model": "llama3.2",
  "prompt": "必ずJSONで回答してください。{\"answer\": string}",
  "format": "json",
  "stream": false
}'

ドキュメント注記: format: "json" 時はプロンプト側でもJSON指定を明示しないと無駄な空白が出る可能性あり。  ￼

2) 構造化出力（JSON Schemaで厳格化・より堅牢）
	•	指定方法: format に JSON Schema オブジェクトを与える（/api/chat など）。
	•	挙動: モデル出力が与えたスキーマの形のJSONになる。Ollama公式ブログで「JSONモードより信頼性・一貫性が高い」と明言。  ￼

curl -X POST http://localhost:11434/api/chat -H "Content-Type: application/json" -d '{
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

公式ブログに cURL/Python/JS のサンプル多数。OpenAI互換クライアントの response_format にも対応例あり。  ￼

LM Studio

構造化出力（OpenAI互換 /v1/chat/completions で JSON Schema を強制）
	•	指定方法: response_format: { "type": "json_schema", "json_schema": { ... } } を指定。
	•	挙動: スキーマに適合したJSONが choices[0].message.content（文字列）に返るため、受側でパースが必要。LM Studioの公式Structured Outputに明記。サーバ起動は Developer タブまたは lms server start。  ￼

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

公式Docに「OpenAIのStructured Output APIと同形式」「一部小規模モデルでは非対応の場合がある」旨の注意。  ￼

実務上の要点（公式情報に基づく運用）
	•	最も堅牢なのは、両者とも JSON Schema を与える構造化出力（Ollama: format にSchema／LM Studio: response_format.json_schema）。  ￼ ￼
	•	JSONは文字列で返る（Ollamaは response、LM Studioは choices[0].message.content）。受信側で必ずパースしてください。  ￼ ￼
	•	プロンプトでもJSON指定を明記（Ollamaの公式が推奨）。  ￼
	•	LM StudioはOpenAI互換サーバとして動作（/v1/chat/completions 等）。起動はDeveloperタブまたは lms server start。  ￼

