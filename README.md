# 譜面大会ツール

太鼓さん次郎の小規模な譜面大会向けのツールです。画面は GitHub Pages、採点の受け渡しは Cloudflare Workers + D1 で動きます。

- **集計モード（主催者）**
  - パック：`.tja` と音源（zip可）から配布用の譜面パックを作る
  - 公開：曲目を公開する（作成者名は伏せる）。あいことばを設定できる。大会はいくつでも作れ、「＋ 新しい大会」で追加・上の一覧で切り替え
  - 集計：届いた採点を集計し、Discord 向けの結果を出力する
- **評価モード（採点者）**：公開中の大会を選び、点数とお気に入りを送信する

## セットアップ（Cloudflare ダッシュボードだけで完結）

1. **D1 を作る**：Storage & Databases → D1 → Create → 名前 `taikai`
2. **Worker を作る**：Workers & Pages → Create → Worker（Hello World）→ 名前 `taikai-api` → Deploy
3. **D1 をつなぐ**：作った Worker → Settings → Bindings → Add → D1 database → 変数名 `DB`、データベース `taikai`
4. **コードを貼る**：Worker → Edit code → `worker/worker.js` の中身で置き換えて Deploy
5. **URL を設定**：Worker の URL（`https://taikai-api.<名前>.workers.dev`）を `config.js` の `API` に書く

テーブルは初回アクセス時に自動で作られます（列の追加も自動）。

### 自動デプロイ（Workers Builds）

Worker の Settings → Builds → Connect で `Mikado420/Evaluation`（ブランチ `main`、Root directory `/worker`）をつなぐと、push のたびに `worker/wrangler.jsonc` の設定で自動デプロイされます。

GitHub Pages は Settings → Pages → Branch を `main` / `(root)` にして保存します。右上の丸が緑なら接続済みです。

## 仕組み

- 各ブラウザがランダムなトークンを持ち、サーバーにはそのハッシュだけを保存します。主催者・採点者の判定はこれで行います。ブラウザのデータを消すと、その大会を管理できなくなります。
- 曲目は、あいことばが合ったときだけ返します。あいことばは端末に保存され、変更されない限り再入力は不要です。
- 参加者名簿（作成者名を五十音順・重複なしで並べたもの）は入室した人に公開します。どの曲を誰が作ったかは主催者にしか返しません。
- 採点を読めるのは主催者だけです。開始・締切の時刻を設定でき、その間だけ送信と修正ができます（時刻はサーバー側で判定）。
- 主催者画面は5秒ごと、大会一覧は10秒ごとに更新します。
