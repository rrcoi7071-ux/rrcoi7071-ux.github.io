# Goblin Moment Web v15

人生の出来事、写真・動画、感情を記録し、事実を変えない短いAI動画として残すスマートフォン向けアプリ。

## 実装済み
- 通常 / 楽しい / 悲しいの3Dゴブリン
- 上半身タップで +、下半身タップで -（-4〜+4）
- 感情強度に応じた画面全体の明暗変化
- 最大3体のゴブリン
- 豊富な絵文字ピッカー / 空間タップで絵文字を追加 / 絵文字タップで削除
- 写真追加（ブラウザの写真選択UIから選択）
- メモ
- IndexedDBによる下書き自動保存
- 保存成功後のみ新規状態へリセット
- 左スワイプでカレンダー / 右スワイプで戻る
- 日付別の履歴 / 詳細表示 / 削除
- PWA manifest / Service Worker
- GPTによる文章整理と動画設計の二段階事実確認
- Seedance 2.0 Miniによる9:16・5秒/10秒の動画生成
- OpenAI / BytePlus APIキーをブラウザに置かないVercel中継API

3Dモデルは元の約75MB・約200万面から、見た目を保ちつつ約25万面・6〜7MBへ軽量化したコピーを使用。元GLBは変更していない。

## 動かすための設定

GitHub Pagesは静的サイトなので、BytePlusへ安全に接続するためにVercelを中継サーバーとして使います。

1. このリポジトリをVercelへImportする。
2. VercelのProject Settings > Environment Variablesに以下を登録する。
   - `OPENAI_API_KEY`: OpenAIのAPIキー
   - `BYTEPLUS_API_KEY`: ModelArkのAPIキー
   - `APP_ORIGIN`: `https://rrcoi7071-ux.github.io`
3. ProductionへDeployする。
4. GitHub Pages版の設定画面を開き、「中継サーバーURL」に発行された `https://...vercel.app` を入力する。

Vercel側のURLでアプリを使う場合、中継サーバーURLは空欄のままで動作します。APIキーをGitHubのファイルやブラウザの設定画面へ書かないでください。

## 通信構造

- `/api/openai`: 文章整理と動画設計をOpenAIへ中継
- `/api/seedance`: Seedanceの生成開始、進捗確認、生成動画の取得をBytePlusへ中継
- 記録・添付メディア・生成動画: 端末のIndexedDBに保存
