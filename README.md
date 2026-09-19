# emoji-suggest

Slack のメッセージに付けるリアクション絵文字の候補を、TypeSafe の Jev で出す Chrome 拡張の試作。
元ネタは #memo-アイデア の「jevを使ってslack絵文字を出すやつ」（2026-09-18）。

形になったら別リポジトリへ切り出す。それまでは `extension/` に実装ごと置く。

## 動かし方

ログイン状態を保つ専用プロファイルで、拡張を読み込ませて開く。

```sh
agent-browser --session slackjev --headed \
  --profile ~/.local/state/slack-jev-reactions/profile \
  --extension ~/ghq/github.com/yamadashy/life/project/emoji-suggest/extension \
  open https://app.slack.com/client/TFL6W9953/CN1RQL0TA
```

初回は拡張の設定画面（`chrome-extension://<ID>/src/options.html`）で API キーを保存する。
ID は `curl -s localhost:<port>/json/list` で拾える（port は `agent-browser ... get cdp-url`）。

**コードを変えたらブラウザを開き直す。さらに `manifest.json` の `version` を上げる。**
Service Worker の登録がプロファイルに残るので、バージョンが同じままだと Chrome が古い
background.js を使い続ける。症状は「拡張機能が応答しませんでした」だけで、
chrome://extensions にはエラーが出ない。ここで一番時間を溶かした。ログインはプロファイルに残る。

## 仕組み

層をまたぐ知識を持たせていない。Slack を知っているのは 1 ファイル、Jev を知っているのも 1 ファイル。

| ファイル | 役割 |
| --- | --- |
| `src/sites/slack.js` | Slack の DOM を知っている唯一の場所。セレクタ、ホバー/ピッカー検知、リアクション実行 |
| `src/content.js` | サイト非依存。デバウンス、キャッシュ、「おすすめ」行の描画、閾値と件数 |
| `src/providers/jev.js` | Jev を知っている唯一の場所。エンドポイント、質問文、回答の読み取り |
| `src/providers/index.js` | どのモデルを使うかの選択。今は `jev` だけ |
| `src/background.js` | API キーを持つ唯一の場所。LRU キャッシュと重複リクエストの合流 |
| `src/candidates.js` | 絵文字候補リストとパーサ。サイトにもモデルにも依存しない |

動きはこう。

1. メッセージにポインタが **250ms 止まったら**、本文を background へ送って先読みする。
   掃くように動かしても飛ばない
2. ツールバーの「リアクションを追加...」を **capture フェーズで捕まえて**、どのメッセージの
   ピッカーが開くのかを覚えておく。Slack はピッカーからメッセージを辿れないので、
   知る機会はこのクリックしかない
3. ピッカーが出たら、検索ボックスの下・「よく使う絵文字」の上に「おすすめ」行を差し込む。
   先読みが間に合っていれば即表示、まだなら placeholder
4. 候補をクリックすると、**ピッカー自身の検索ボックスにショートコードを打ち込んで**、
   絞り込まれた 1 件を click する。グリッドは仮想化されていてスクロール範囲外の絵文字には
   DOM が無いので、検索を経由すれば必ず描画された状態で掴める。Slack の API トークンは使わない

セレクタは `src/sites/slack.js` の `SEL` に集約。全部 `data-qa` か ARIA で、ハッシュ付きの
クラス名は使っていない（`data-qa` は Slack 自身の E2E テスト用なので比較的変わりにくい）。
ピッカーだけ `data-qa="emoji-picker"` とハイフン、ボタンは `add_reaction` とアンダースコアで揺れている。

MutationObserver は常駐させていない。ボタンのクリックからピッカーが現れるまでの数百 ms だけ
`body` に張って、見つけたら切る。ホバーは委譲リスナー 1 個（Slack は行を再利用するので、
行ごとに付けると漏れる）。

プライバシー: 本文が TypeSafe へ出るのは、そのメッセージにポインタを合わせたときと、
ピッカーを開いたときだけ。チャンネルを走査することはない。

## 分かっていること

ai-lab の `/jev` ページ「絵文字リアクション」タブ（`web/src/components/jev/EmojiTab.tsx`）で先に試した結果と、今回の実機での確認。質問文と絵文字の説明リストはそこから流用した。

- 応答は 0.5 秒前後。ホバーツールバーが出た時点で問い合わせれば、ピッカーを開く頃には間に合う
- Choice の選択肢は 1 問あたり 255 個まで（超えると 400）。255 個でも速度・精度は落ちなかった
- 候補を複数出す用途には、絵文字ごとの Noul のほうが向く。Choice は確率の合計が 1 なので、1 個が勝つと他が沈む
- 絵文字の説明は「Slack でその絵文字が何を意味するか」を英語で書くと効く。Jev は質問を字面どおりに読む
- **Noul の甘さはメッセージの種類で変わる。** 仕事の報告（「本番環境へのデプロイが完了しました。
  エラーは出ていません。」）なら :ship: 0.96 / :white_check_mark: 0.93 / :tada: 0.93 と 0.8 台が並ぶ。
  一方 #memo-アイデア のような一行メモは全体が低く、「jevを使ってslack絵文字を出すやつ」で
  最高 :smile: 0.65。閾値 0.8 だとこのチャンネルでは何も出ない。
  **実装では 0.5 にした**（`src/content.js` の `MIN_SCORE`）
- 一行メモでも中身は拾えている。「readable-messag は readable-plain-text にしたほうがいいかも。」
  → :bulb: 0.78 / :thinking_face: 0.75 / :ok_hand: 0.69 / :+1: 0.67 / :eyes: 0.63

## 制約

- Slack のデスクトップアプリは Electron なので Chrome 拡張を載せられない。ブラウザ版専用
- Slack の DOM は公開 API ではないので、変わったらセレクタを直す
- メッセージ本文を TypeSafe に送る。問い合わせはホバーとピッカーを開いたときだけにする
- API キーは background 側で持ち、ページには渡さない
- ホバーツールバーは、ウィンドウが前面に無い（`document.visibilityState === "hidden"`）と
  Slack が出さない。自動操作で確認するときはウィンドウを可視にしてから
- `agent-browser set viewport` を使うとホバーツールバーが出なくなる（タッチデバイス扱いに
  なるものと思われる）。実機確認では使わない
- ダークテーマでの見た目は未確認。テーマ切り替えが Slack の設定画面なので触っていない。
  CSS は色を直書きせず `currentColor` と半透明グレーだけで組んであるので、原理上は追従する

## これから

- ワークスペース独自の絵文字は候補に足せるが、絵文字画像が無いのでショートコード文字で出る。
  Slack の絵文字一覧を読めれば画像を出せる
- 閾値（`MIN_SCORE`）と表示件数が決め打ち。設定画面に出してもいい
- Discord 対応は `src/sites/` にもう 1 ファイル足せば届く形にしてある（まだ書いていない）
