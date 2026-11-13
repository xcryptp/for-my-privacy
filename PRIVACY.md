# Privacy Policy

**English** · [한국어](#한국어) · [日本語](#日本語)

Last updated: 2026-11-13 · Version 0.1.0

## English

For My Privacy does not collect, send or share any data. It makes no network requests at all, has no analytics or tracking, and loads no code from anywhere else.

### What is stored, and where

The extension keeps this in `chrome.storage.local`, on your computer only:

- Your password, as a PBKDF2-SHA256 hash with a random salt (600,000 iterations). The password itself is never stored and cannot be recovered from the hash by the extension. If you forget it, remove the extension and install it again to reset it. That also erases everything else below.
- The list of sites you chose to lock.
- Your settings: auto-lock minutes, lock on screen lock, extensions-page guard, and whether one unlock opens all locked sites or only the site you unlocked.
- A count of recent wrong passwords and the time until the next try is allowed.
- The web origins (scheme, host and port, never a page path) of addresses under your locked sites that a tab or frame has shown, such as `a.b.instagram.com`. The extension needs them to remove those sites' service workers and caches when it locks again. An origin is dropped once its site leaves your list.
- For each lock screen that the extension opened itself when the lock came back (not one you reached by visiting a locked site), the address of the page it will open after you unlock, kept under a random code. It is kept so the lock screen survives a Chrome restart or an extension update. It is deleted when you unlock, when that tab closes, and at the next lock for any tab that is gone.
- While the first-run setup is unfinished: the step you reached and the sites you picked so far. They are deleted when you click Finish.

While Chrome is running, it also keeps these short-lived values in `chrome.storage.session`, which Chrome holds in memory and clears when it closes: the time the screen locked (used when "lock when the screen locks" is off); the IDs of the tabs that showed a locked site, or showed one inside a frame, since the last lock; whether the settings (and, when one unlock opens only one site, Chrome's extensions page) are unlocked; and, for each open lock screen, the address of the page it will open after you unlock, kept under a random code so the lock screen itself does not show it (for lock screens the extension opened itself, a copy is also in `chrome.storage.local`, see above). Which sites are unlocked is held as a Chrome session rule, also in memory only.

It does not use `chrome.storage.sync`, so nothing is copied to your Google account or to other devices. Removing the extension deletes all of it.

The lock page is a web-accessible page of the extension, so any website can find out that For My Privacy is installed. It cannot read your site list, your settings or anything stored above.

### Why each permission is needed

| Permission | Why |
| --- | --- |
| `declarativeNetRequest` | Block locked sites and send them to the lock screen. Chrome shows "Block content on any page" at install for this permission; the extension only acts on the sites you add. |
| `storage` | Keep your settings and password hash on your device. |
| `idle` | Lock again after a time without keyboard or mouse input, or when the screen locks. |
| `tabs` | Read tab addresses to find tabs of locked sites, move them to the lock screen, and guard Chrome's extensions page. The addresses are compared with your list; only what is described above is kept. Chrome shows "Read your browsing history" for this permission. |
| `webNavigation` | See frames that show a locked site inside another page, so those pages can be reloaded when the lock comes back. Chrome shows the same "Read your browsing history" notice as for `tabs`. |
| `browsingData` | Remove the service workers and cache storage of locked sites each time the lock comes back, so a site cannot answer from its saved copy. It never removes cookies, logins or anything else, and only for your locked sites. Chrome shows no notice for it. |
| Site access (optional) | Asked for one site at a time, when you add it. |

### Contact

Questions or concerns: open an issue at <https://github.com/xcryptp/for-my-privacy/issues>.

## 한국어

For My Privacy는 어떤 데이터도 수집하거나 보내거나 공유하지 않습니다. 네트워크 요청을 전혀 하지 않고, 분석이나 추적 도구도 없으며, 다른 곳에서 코드를 가져오지도 않습니다.

### 무엇을 어디에 저장하나요

확장 프로그램은 아래 내용을 이 컴퓨터의 `chrome.storage.local`에만 저장합니다.

- 비밀번호: 무작위 salt를 쓴 PBKDF2-SHA256 해시(60만 회 반복)로만 저장합니다. 비밀번호 원문은 저장하지 않으며, 확장 프로그램이 해시에서 되살릴 수도 없습니다. 잊으면 확장 프로그램을 삭제하고 다시 설치해 초기화하세요. 아래의 다른 내용도 함께 지워집니다.
- 잠그려고 고른 사이트 목록
- 설정: 자동 잠금 시간, 화면이 잠기면 잠금, 확장 관리 화면 보호, 한 번 풀면 잠긴 사이트가 모두 열릴지 푼 사이트만 열릴지
- 최근에 비밀번호를 틀린 횟수와 다음 시도까지 기다려야 하는 시간
- 잠근 사이트 아래의 주소(예: `a.b.instagram.com`)를 탭이나 프레임이 보여 준 적이 있을 때, 그 웹 출처(스킴, 호스트, 포트이며 페이지 경로는 없음). 다시 잠글 때 그 사이트들의 서비스 워커와 캐시를 지우려고 필요합니다. 사이트가 목록에서 빠지면 그 출처도 지워집니다.
- 잠글 때 확장 프로그램이 직접 연 잠금 화면(잠긴 사이트를 직접 방문해서 만난 잠금 화면은 해당하지 않음)마다, 잠금을 푼 뒤 열 페이지의 주소를 무작위 코드에 묶어 보관합니다. 크롬을 다시 시작하거나 확장 프로그램을 업데이트해도 잠금 화면이 이어지도록 하기 위해서입니다. 잠금을 풀 때, 그 탭을 닫을 때, 그리고 없어진 탭의 주소는 다음 잠금 때 지워집니다.
- 처음 실행 설정을 끝내지 않았을 때: 도달한 단계와 지금까지 고른 사이트. **완료**를 누르면 지워집니다.

크롬이 켜져 있는 동안에는 잠깐 쓰는 값도 `chrome.storage.session`에 둡니다. 크롬이 메모리에만 두고 크롬을 끄면 지우는 공간입니다. 화면이 잠긴 시각("화면이 잠기면 함께 잠그기"를 껐을 때 씀), 마지막으로 잠긴 뒤 잠긴 사이트를 보여 준 탭(프레임으로 보여 준 탭 포함)의 ID, 설정(그리고 한 번에 한 사이트만 푸는 설정일 때 크롬 확장 프로그램 페이지)이 풀려 있는지, 그리고 열려 있는 잠금 화면마다 잠금을 푼 뒤 열 페이지의 주소입니다. 이 주소는 무작위 코드에 묶어 두어 잠금 화면에는 보이지 않습니다(확장 프로그램이 직접 연 잠금 화면의 주소는 위의 `chrome.storage.local`에도 사본이 있습니다). 어떤 사이트가 풀려 있는지는 크롬의 세션 규칙으로 보관하며, 이것도 메모리에만 있습니다.

`chrome.storage.sync`는 쓰지 않으므로 Google 계정이나 다른 기기로 복사되지 않습니다. 확장 프로그램을 삭제하면 모두 지워집니다.

잠금 화면은 웹에서 접근할 수 있는 확장 프로그램 페이지라서, 어떤 웹사이트든 For My Privacy가 설치되어 있다는 것은 알아낼 수 있습니다. 사이트 목록, 설정, 위에 적은 저장 내용은 읽을 수 없습니다.

### 권한이 필요한 이유

| 권한 | 이유 |
| --- | --- |
| `declarativeNetRequest` | 잠긴 사이트를 막고 잠금 화면으로 보냅니다. 이 권한 때문에 설치할 때 "모든 페이지의 콘텐츠 차단"이라는 안내가 뜨지만, 확장 프로그램은 추가한 사이트에만 동작합니다. |
| `storage` | 설정과 비밀번호 해시를 이 기기에 보관합니다. |
| `idle` | 키보드·마우스 입력이 없는 시간이 지나거나 화면이 잠기면 다시 잠급니다. |
| `tabs` | 탭 주소를 읽어 잠긴 사이트의 탭을 찾아 잠금 화면으로 바꾸고, 크롬 확장 관리 화면을 지킵니다. 주소는 잠글 사이트 목록과 견주기만 하며, 위에서 설명한 것만 보관합니다. 이 권한에는 크롬이 "Read your browsing history"(방문 기록 읽기) 안내를 띄웁니다. |
| `webNavigation` | 다른 페이지 안에 프레임으로 들어간 잠긴 사이트를 알아차려, 다시 잠길 때 그 페이지를 새로 고칩니다. 크롬이 `tabs`와 같은 "Read your browsing history" 안내를 띄웁니다. |
| `browsingData` | 다시 잠길 때마다 잠긴 사이트의 서비스 워커와 캐시 저장소를 지워, 사이트가 저장해 둔 사본으로 대신 답하지 못하게 합니다. 쿠키, 로그인 등 다른 것은 지우지 않으며, 잠근 사이트만 대상으로 합니다. 크롬은 이 권한에 안내를 띄우지 않습니다. |
| 사이트 접근(선택) | 사이트를 추가할 때 그 사이트만 하나씩 요청합니다. |

### 문의

질문이나 걱정되는 점은 <https://github.com/xcryptp/for-my-privacy/issues>에 이슈로 남겨 주세요.

## 日本語

For My Privacy は、データを収集・送信・共有しません。ネットワーク通信は一切行わず、分析や追跡の仕組みもなく、外部からコードを読み込むこともありません。

### 何をどこに保存するか

拡張機能は次の内容を、このパソコンの `chrome.storage.local` にだけ保存します。

- パスワード：ランダムな salt を使った PBKDF2-SHA256 のハッシュ（60万回）としてのみ保存します。パスワードそのものは保存せず、拡張機能がハッシュから元に戻すこともできません。忘れた場合は、拡張機能を削除して入れ直し、初期化してください。下のほかの内容も、いっしょに消えます。
- ロックするために選んだサイトの一覧
- 設定：自動ロックの時間、画面ロック時にロック、拡張機能ページの保護、1回の解除でロックしたサイトがすべて開くか、解除したサイトだけが開くか
- 最近パスワードを間違えた回数と、次に試せるまでの待ち時間
- ロック対象サイトの下にあるアドレス（たとえば `a.b.instagram.com`）をタブやフレームが表示したことがあるときの、そのウェブのオリジン（スキーム、ホスト、ポート。ページのパスは含みません）。再ロックのときに、それらのサイトのサービスワーカーとキャッシュを消すために必要です。サイトが一覧から外れると、そのオリジンも消えます。
- 再ロックのときに拡張機能が自分で開いたロック画面（ロック対象サイトを自分で開いて出たロック画面は含みません）ごとの、解除後に開くページのアドレスを、ランダムなコードに結び付けて保存します。Chrome の再起動や拡張機能の更新のあとでもロック画面が続くようにするためです。ロックを解除したとき、そのタブを閉じたとき、そして、なくなったタブの分は次のロックのときに削除されます。
- 初回のセットアップが終わっていないとき：到達したステップと、そこまでに選んだサイト。**完了**を押すと消えます。

Chrome の起動中は、一時的な値も `chrome.storage.session` に置きます。Chrome がメモリにだけ置き、Chrome を閉じると消す場所です。画面がロックされた時刻（「画面がロックされたら、サイトもロックする」をオフにしたときに使用）、前回のロック以降にロック対象サイトを表示した（フレームの中に表示した場合を含む）タブの ID、設定（および、1回の解除で1つのサイトだけが開く設定のときは Chrome の拡張機能ページ）が解除されているかどうか、そして、開いているロック画面ごとの、解除したあとに開くページのアドレスです。このアドレスはランダムなコードに結び付けて保管するので、ロック画面には表示されません（拡張機能が自分で開いたロック画面の分は、上の `chrome.storage.local` にもコピーがあります）。どのサイトが解除されているかは、Chrome のセッション規則として保持し、これもメモリにだけあります。

`chrome.storage.sync` は使わないので、Google アカウントや他の端末にはコピーされません。拡張機能を削除すると、すべて消えます。

ロック画面はウェブから参照できる拡張機能のページなので、どのウェブサイトでも For My Privacy が入っていることは調べられます。サイトの一覧、設定、上に書いた保存内容は読み取れません。

### 各権限が必要な理由

| 権限 | 理由 |
| --- | --- |
| `declarativeNetRequest` | ロックしたサイトをブロックし、ロック画面へ移動させます。この権限のため、インストール時に「あらゆるページのコンテンツをブロック」と表示されますが、拡張機能が動くのは追加したサイトだけです。 |
| `storage` | 設定とパスワードのハッシュをこの端末に保存します。 |
| `idle` | キーボードやマウスの操作がない時間が続いたとき、または画面がロックされたときに、再びロックします。 |
| `tabs` | タブのアドレスを読んで、ロック対象サイトのタブを見つけてロック画面に切り替え、Chrome の拡張機能ページを保護します。アドレスはロックするサイトの一覧と照らし合わせるだけで、保存するのは上で説明したものだけです。この権限に対して、Chrome は「Read your browsing history」（閲覧履歴の読み取り）という通知を表示します。 |
| `webNavigation` | ほかのページの中にフレームとして入っているロック対象サイトに気づき、再ロックのときにそのページを再読み込みします。Chrome は、`tabs` と同じ「Read your browsing history」の通知を表示します。 |
| `browsingData` | 再ロックのたびに、ロック対象サイトのサービスワーカーとキャッシュストレージを消し、サイトが保存済みのコピーで代わりに応答できないようにします。Cookie、ログインなどほかのものは消さず、対象はロックしたサイトだけです。Chrome はこの権限に通知を表示しません。 |
| サイトへのアクセス（任意） | サイトを追加するときに、そのサイトだけを1つずつ要求します。 |

### お問い合わせ

質問や気になる点は、<https://github.com/xcryptp/for-my-privacy/issues> に Issue として書き込んでください。
