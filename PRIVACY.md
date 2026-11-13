# Privacy Policy

**English** · [한국어](#한국어) · [日本語](#日本語)

Last updated: 2026-11-13 · Version 0.1.0

## English

For My Privacy does not collect, send or share any data. It makes no network requests at all, has no analytics or tracking, and loads no code from anywhere else.

### What is stored, and where

The extension keeps this in `chrome.storage.local`, on your computer only:

- Your password, as a PBKDF2-SHA256 hash with a random salt (600,000 iterations). The password itself is never stored and cannot be recovered from the hash by the extension. If you forget it, reinstall the extension to reset it.
- The list of sites you chose to lock.
- Your settings: auto-lock minutes, lock on screen lock, extensions-page guard.
- A count of recent wrong passwords and the time until the next try is allowed.

While Chrome is running, it also keeps two short-lived values in `chrome.storage.session`, which Chrome holds in memory and clears when it closes: the time the screen locked (used when "lock when the screen locks" is off) and the IDs of the tabs that showed a locked site since the last lock.

It does not use `chrome.storage.sync`, so nothing is copied to your Google account or to other devices. Removing the extension deletes all of it.

### Why each permission is needed

| Permission | Why |
| --- | --- |
| `declarativeNetRequest` | Block locked sites and send them to the lock screen. Chrome shows "Block content on any page" at install for this permission; the extension only acts on the sites you add. |
| `storage` | Keep your settings and password hash on your device. |
| `idle` | Lock again after a time without keyboard or mouse input, or when the screen locks. |
| `tabs` | Move open tabs of locked sites to the lock screen, and guard Chrome's extensions page. |
| Site access (optional) | Asked for one site at a time, when you add it. |

### Contact

Questions or concerns: open an issue at <https://github.com/xcryptp/for-my-privacy/issues>.

## 한국어

For My Privacy는 어떤 데이터도 수집하거나 보내거나 공유하지 않습니다. 네트워크 요청을 전혀 하지 않고, 분석이나 추적 도구도 없으며, 다른 곳에서 코드를 가져오지도 않습니다.

### 무엇을 어디에 저장하나요

확장 프로그램은 아래 내용을 이 컴퓨터의 `chrome.storage.local`에만 저장합니다.

- 비밀번호: 무작위 salt를 쓴 PBKDF2-SHA256 해시(60만 회 반복)로만 저장합니다. 비밀번호 원문은 저장하지 않으며, 확장 프로그램이 해시에서 되살릴 수도 없습니다. 잊으면 확장 프로그램을 다시 설치해 초기화하세요.
- 잠그려고 고른 사이트 목록
- 설정: 자동 잠금 시간, 화면이 잠기면 잠금, 확장 관리 화면 보호
- 최근에 비밀번호를 틀린 횟수와 다음 시도까지 기다려야 하는 시간

크롬이 켜져 있는 동안에는 잠깐 쓰는 값 두 가지를 `chrome.storage.session`에도 둡니다. 크롬이 메모리에만 두고 크롬을 끄면 지우는 공간입니다. 화면이 잠긴 시각("화면이 잠기면 함께 잠그기"를 껐을 때 씀)과, 마지막으로 잠긴 뒤 잠긴 사이트를 보여 준 탭의 ID입니다.

`chrome.storage.sync`는 쓰지 않으므로 Google 계정이나 다른 기기로 복사되지 않습니다. 확장 프로그램을 삭제하면 모두 지워집니다.

### 권한이 필요한 이유

| 권한 | 이유 |
| --- | --- |
| `declarativeNetRequest` | 잠긴 사이트를 막고 잠금 화면으로 보냅니다. 이 권한 때문에 설치할 때 "모든 페이지의 콘텐츠 차단"이라는 안내가 뜨지만, 확장 프로그램은 추가한 사이트에만 동작합니다. |
| `storage` | 설정과 비밀번호 해시를 이 기기에 보관합니다. |
| `idle` | 키보드·마우스 입력이 없는 시간이 지나거나 화면이 잠기면 다시 잠급니다. |
| `tabs` | 열려 있는 잠긴 사이트의 탭을 잠금 화면으로 바꾸고, 크롬 확장 관리 화면을 지킵니다. |
| 사이트 접근(선택) | 사이트를 추가할 때 그 사이트만 하나씩 요청합니다. |

### 문의

질문이나 걱정되는 점은 <https://github.com/xcryptp/for-my-privacy/issues>에 이슈로 남겨 주세요.

## 日本語

For My Privacy は、データを収集・送信・共有しません。ネットワーク通信は一切行わず、分析や追跡の仕組みもなく、外部からコードを読み込むこともありません。

### 何をどこに保存するか

拡張機能は次の内容を、このパソコンの `chrome.storage.local` にだけ保存します。

- パスワード：ランダムな salt を使った PBKDF2-SHA256 のハッシュ（60万回）としてのみ保存します。パスワードそのものは保存せず、拡張機能がハッシュから元に戻すこともできません。忘れた場合は、拡張機能を入れ直して初期化してください。
- ロックするために選んだサイトの一覧
- 設定：自動ロックの時間、画面ロック時にロック、拡張機能ページの保護
- 最近パスワードを間違えた回数と、次に試せるまでの待ち時間

Chrome の起動中は、一時的な値を2つ `chrome.storage.session` にも置きます。Chrome がメモリにだけ置き、Chrome を閉じると消す場所です。画面がロックされた時刻（「画面がロックされたら、サイトもロックする」をオフにしたときに使用）と、前回のロック以降にロック対象サイトを表示したタブの ID です。

`chrome.storage.sync` は使わないので、Google アカウントや他の端末にはコピーされません。拡張機能を削除すると、すべて消えます。

### 各権限が必要な理由

| 権限 | 理由 |
| --- | --- |
| `declarativeNetRequest` | ロックしたサイトをブロックし、ロック画面へ移動させます。この権限のため、インストール時に「あらゆるページのコンテンツをブロック」と表示されますが、拡張機能が動くのは追加したサイトだけです。 |
| `storage` | 設定とパスワードのハッシュをこの端末に保存します。 |
| `idle` | キーボードやマウスの操作がない時間が続いたとき、または画面がロックされたときに、再びロックします。 |
| `tabs` | 開いているロック対象サイトのタブをロック画面に切り替え、Chrome の拡張機能ページを保護します。 |
| サイトへのアクセス（任意） | サイトを追加するときに、そのサイトだけを1つずつ要求します。 |

### お問い合わせ

質問や気になる点は、<https://github.com/xcryptp/for-my-privacy/issues> に Issue として書き込んでください。
