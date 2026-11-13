# Chrome Web Store listing

**English** · [한국어](#한국어) · [日本語](#日本語)

Texts for the Chrome Web Store developer dashboard, version 0.1.0. Every fact comes from the code, [README.md](../README.md) and [PRIVACY.md](../PRIVACY.md); change this file when they change. The short description is the manifest `description` (`extDescription` in `public/_locales/<lang>/messages.json`), which the store shows as the summary; it must stay at 132 characters or fewer.

Privacy policy link for every language: <https://github.com/xcryptp/for-my-privacy/blob/main/PRIVACY.md> (the file [PRIVACY.md](../PRIVACY.md) has English, Korean and Japanese sections).

## English

### Short description (96 characters)

Lock chosen sites and all their subdomains behind a password. It locks again when you step away.

### Full description

For My Privacy puts a password on the websites you choose. It is made for one situation: someone else sitting at your unlocked, logged-in Chrome while you are away.

What it does
- Add a site such as instagram.com, and the site and all its subdomains (www.instagram.com, help.instagram.com) show a lock screen instead of the page. Look-alike names such as notinstagram.com are left alone.
- One password opens every locked site and the settings page. It is stored only as a salted PBKDF2-SHA256 hash and cannot be recovered. If you forget it, remove the extension and install it again.
- It locks again by itself: after 1 to 60 minutes without keyboard or mouse input (5 by default), when the screen locks (you can switch this off), when the last Chrome window closes, and when Chrome restarts.
- When it locks again, open tabs of locked sites turn into the lock screen, and Back does not bring the old page back.
- After 5 wrong passwords, each new try has to wait longer, up to 15 minutes.
- Screens in English, Korean and Japanese.

Chrome's extensions page is guarded too
While your sites are locked, opening Chrome's extensions page (chrome://extensions) shows the lock screen and asks for the password, so the extension cannot simply be switched off there. This is on by default. You can turn it off in Settings with "Ask for the password before Chrome's extensions page opens". Chrome still lets anyone remove an extension from the toolbar menu; the README explains optional Chrome policies that stop that.

Why Chrome says "Block content on any page"
Chrome shows the declarativeNetRequest permission as "Block content on any page". For My Privacy uses it only for the sites you add. It needs this permission so that a locked site stays blocked even if its site access is later withdrawn from the toolbar menu; the site then shows Chrome's blocked page, never its content.

Private
Nothing is collected or sent. No network requests, no analytics, no account. The password hash, your site list and your settings stay in Chrome's storage on your computer.

What it does not stop: a person who controls your computer, for example its administrator, or someone using Chrome DevTools or editing Chrome's profile files. The README lists these limits.

Open source (MIT): https://github.com/xcryptp/for-my-privacy

### Single purpose

Lock the websites the user chooses behind a password, and lock them again when the user steps away.

### Permission justifications

| Permission | Justification |
| --- | --- |
| `declarativeNetRequest` | Holds the rules that send page requests for the sites the user locked to the extension's lock page, block those sites inside frames on other pages, and let them through for the rest of the browser session after the right password. The rules list only the user's sites. |
| `storage` | Keeps the password hash, the list of locked sites and the settings in `chrome.storage.local` on the device. While Chrome runs, `chrome.storage.session` also holds the time the screen locked and the IDs of tabs that showed a locked site; Chrome clears it when it closes. |
| `idle` | Notices when there has been no keyboard or mouse input for the chosen number of minutes, and when the screen locks, so the sites lock again. |
| `tabs` | Reads tab addresses to find tabs that show, or earlier showed, a locked site; replaces them with the lock page when the lock comes back; sends lock pages back to their site after unlocking; and shows the lock page instead of `chrome://extensions` while locked (the guard, which the user can turn off). |
| Host access, optional (`*://*/*`) | Nothing is granted at install. When the user adds a site, the extension asks for access to that one site and its subdomains. Chrome needs it to send that site's pages to the lock page; without it the site is still blocked, but shows Chrome's blocked page instead. |

### Remote code

No. All code is inside the extension package; nothing is loaded from anywhere else.

### Data use

- Collected data: none. The extension does not collect or send any of the listed kinds of data; it makes no network requests.
- Stored on the device only: the password hash, the site list and the settings (see the storage justification above).
- Certifications: the data is not sold or transferred to third parties, not used for anything unrelated to the single purpose, and not used to decide creditworthiness or for lending.

## 한국어

### 간단한 설명(49자)

선택한 사이트와 그 하위 주소를 모두 비밀번호로 잠급니다. 자리를 비우면 다시 잠깁니다.

### 자세한 설명

For My Privacy는 내가 고른 웹사이트에 비밀번호를 겁니다. 막으려는 상황은 하나입니다. 자리를 비운 사이, 로그인된 내 크롬 앞에 다른 사람이 앉는 것입니다.

하는 일
- instagram.com 같은 사이트를 추가하면 그 사이트와 모든 하위 주소(www.instagram.com, help.instagram.com)에서 페이지 대신 잠금 화면이 뜹니다. notinstagram.com처럼 이름만 비슷한 사이트는 건드리지 않습니다.
- 비밀번호 하나로 잠긴 모든 사이트와 설정 화면이 열립니다. 비밀번호는 salt를 쓴 PBKDF2-SHA256 해시로만 저장되며 되살릴 수 없습니다. 잊으면 확장 프로그램을 삭제하고 다시 설치하세요.
- 알아서 다시 잠깁니다. 키보드·마우스 입력이 1-60분(기본 5분) 동안 없을 때, 화면이 잠길 때(끌 수 있음), 마지막 크롬 창을 닫을 때, 크롬을 다시 켤 때입니다.
- 다시 잠길 때 열려 있던 잠긴 사이트의 탭은 잠금 화면으로 바뀌고, 뒤로 가기를 눌러도 원래 페이지가 다시 보이지 않습니다.
- 5번 틀리면 그 뒤로는 시도할 때마다 기다리는 시간이 길어지며, 최대 15분입니다.
- 한국어·영어·일본어 화면을 지원합니다.

크롬 확장 프로그램 페이지도 지킵니다
사이트가 잠겨 있는 동안 크롬 확장 프로그램 페이지(chrome://extensions)를 열면 잠금 화면이 뜨고 비밀번호를 묻습니다. 그래서 그 페이지에서 확장 프로그램을 간단히 끌 수 없습니다. 기본으로 켜져 있고, 설정의 "Chrome 확장 프로그램 페이지를 열기 전에 비밀번호 묻기"에서 끌 수 있습니다. 툴바 메뉴에서 확장 프로그램을 삭제하는 것은 크롬이 누구에게나 허용하므로 막지 못합니다. 이를 막는 크롬 정책(선택)은 README에 설명해 두었습니다.

크롬이 "모든 페이지의 콘텐츠 차단"이라고 표시하는 이유
크롬은 declarativeNetRequest 권한을 "모든 페이지의 콘텐츠 차단"이라고 표시합니다. For My Privacy는 이 권한을 내가 추가한 사이트에만 씁니다. 나중에 툴바 메뉴에서 사이트 접근 권한이 빠져도 잠긴 사이트를 계속 막으려면 이 권한이 필요합니다. 그때 그 사이트에는 내용 대신 크롬의 차단 화면이 뜹니다.

개인정보
아무것도 수집하거나 보내지 않습니다. 네트워크 요청도, 분석 도구도, 계정도 없습니다. 비밀번호 해시, 사이트 목록, 설정은 내 컴퓨터의 크롬 저장 공간에만 남습니다.

막지 못하는 것: 컴퓨터 자체를 장악한 사람입니다. 예를 들어 컴퓨터 관리자, 크롬 개발자 도구를 쓰는 사람, 크롬 프로필 파일을 고치는 사람입니다. 자세한 한계는 README에 있습니다.

오픈소스(MIT): https://github.com/xcryptp/for-my-privacy

### 단일 목적

사용자가 고른 웹사이트를 비밀번호로 잠그고, 사용자가 자리를 비우면 다시 잠급니다.

### 권한이 필요한 이유

| 권한 | 이유 |
| --- | --- |
| `declarativeNetRequest` | 사용자가 잠근 사이트의 페이지 요청을 확장 프로그램의 잠금 화면으로 보내고, 다른 페이지에 끼워 넣은 그 사이트를 막고, 비밀번호가 맞으면 브라우저를 끌 때까지 통과시키는 규칙을 둡니다. 규칙에는 사용자가 추가한 사이트만 들어갑니다. |
| `storage` | 비밀번호 해시, 잠긴 사이트 목록, 설정을 이 기기의 `chrome.storage.local`에 보관합니다. 크롬이 켜져 있는 동안에는 화면이 잠긴 시각과 잠긴 사이트를 보여 준 탭의 ID도 `chrome.storage.session`에 두며, 크롬을 끄면 지워집니다. |
| `idle` | 정한 시간 동안 키보드·마우스 입력이 없을 때와 화면이 잠길 때를 알아차려 사이트를 다시 잠급니다. |
| `tabs` | 탭 주소를 읽어 잠긴 사이트를 보여 주고 있거나 전에 보여 준 탭을 찾고, 다시 잠길 때 그 탭을 잠금 화면으로 바꾸고, 잠금을 풀면 잠금 화면 탭을 원래 사이트로 돌려보내고, 잠긴 동안 `chrome://extensions` 대신 잠금 화면을 띄웁니다(사용자가 끌 수 있는 보호 기능). |
| 사이트 접근(선택, `*://*/*`) | 설치할 때는 아무 접근도 받지 않습니다. 사용자가 사이트를 추가하면 그 사이트와 하위 주소에 대한 접근만 요청합니다. 크롬은 이 접근이 있어야 그 사이트의 페이지를 잠금 화면으로 보낼 수 있습니다. 접근이 없으면 사이트는 여전히 막히지만 크롬의 차단 화면이 뜹니다. |

### 원격 코드

사용하지 않습니다. 모든 코드는 확장 프로그램 패키지 안에 있으며, 다른 곳에서 가져오는 코드는 없습니다.

### 데이터 사용

- 수집하는 데이터: 없습니다. 목록의 어떤 종류의 데이터도 수집하거나 보내지 않으며, 네트워크 요청을 하지 않습니다.
- 이 기기에만 저장하는 것: 비밀번호 해시, 사이트 목록, 설정(위 `storage` 항목 참고)
- 확인 사항: 데이터를 제3자에게 팔거나 넘기지 않고, 단일 목적과 관계없는 일에 쓰지 않으며, 신용도 판단이나 대출 목적으로 쓰지 않습니다.

## 日本語

### 簡単な説明（54文字）

選んだサイトとそのサブドメインをすべてパスワードでロックします。席を離れると、自動でもう一度ロックされます。

### 詳しい説明

For My Privacy は、あなたが選んだウェブサイトにパスワードをかけます。想定している状況は1つです。席を離れている間に、ログイン済みのあなたの Chrome の前に別の人が座ることです。

できること
- instagram.com のようなサイトを追加すると、そのサイトとすべてのサブドメイン（www.instagram.com、help.instagram.com）で、ページの代わりにロック画面が表示されます。notinstagram.com のように名前が似ているだけのサイトには手を出しません。
- ロックされたすべてのサイトと設定画面が、1つのパスワードで開きます。パスワードは salt 付きの PBKDF2-SHA256 ハッシュとしてのみ保存され、元に戻すことはできません。忘れた場合は、拡張機能を削除してインストールし直してください。
- 自動でまたロックします。キーボードやマウスの操作が1-60分（初期設定は5分）ないとき、画面がロックされたとき（オフにできます）、最後の Chrome ウィンドウを閉じたとき、Chrome を起動し直したときです。
- 再ロックのとき、開いているロック対象サイトのタブはロック画面に切り替わり、「戻る」を押しても元のページは表示されません。
- 5回間違えると、その後は試すたびに待ち時間が長くなり、最大15分になります。
- 日本語・英語・韓国語の画面に対応しています。

Chrome の拡張機能ページも守ります
サイトがロックされている間に Chrome の拡張機能ページ（chrome://extensions）を開くと、ロック画面が表示され、パスワードを求めます。そのため、このページで拡張機能を簡単にオフにすることはできません。初期設定でオンになっており、設定の「Chromeの拡張機能ページを開く前にパスワードを求める」でオフにできます。ツールバーのメニューから拡張機能を削除することは、Chrome が誰にでも許しているため防げません。これを防ぐ Chrome のポリシー（任意）は README で説明しています。

Chrome が「あらゆるページのコンテンツをブロック」と表示する理由
Chrome は declarativeNetRequest 権限を「あらゆるページのコンテンツをブロック」と表示します。For My Privacy がこの権限を使うのは、あなたが追加したサイトだけです。あとでツールバーのメニューからサイトへのアクセス権が外されても、ロック対象サイトをブロックし続けるために、この権限が必要です。そのときサイトには、中身の代わりに Chrome のブロック画面が表示されます。

プライバシー
何も集めず、何も送りません。ネットワーク通信も、分析ツールも、アカウントもありません。パスワードのハッシュ、サイトの一覧、設定は、あなたのパソコンの Chrome の保存領域にだけ残ります。

防げないこと：パソコンそのものを自由に操作できる人です。たとえばパソコンの管理者、Chrome のデベロッパーツールを使う人、Chrome のプロファイルファイルを書き換える人です。詳しい限界は README にあります。

オープンソース（MIT）：https://github.com/xcryptp/for-my-privacy

### 単一用途

ユーザーが選んだウェブサイトをパスワードでロックし、ユーザーが席を離れたらもう一度ロックします。

### 権限が必要な理由

| 権限 | 理由 |
| --- | --- |
| `declarativeNetRequest` | ユーザーがロックしたサイトのページへのリクエストを拡張機能のロック画面へ送り、ほかのページに埋め込まれたそのサイトをブロックし、正しいパスワードのあとはブラウザを閉じるまで通す規則を置きます。規則に入るのは、ユーザーが追加したサイトだけです。 |
| `storage` | パスワードのハッシュ、ロック対象サイトの一覧、設定を、この端末の `chrome.storage.local` に保存します。Chrome の起動中は、画面がロックされた時刻と、ロック対象サイトを表示したタブの ID も `chrome.storage.session` に置きます。これは Chrome を閉じると消えます。 |
| `idle` | 決めた時間キーボードやマウスの操作がないとき、そして画面がロックされたときに気づき、サイトをもう一度ロックします。 |
| `tabs` | タブのアドレスを読んで、ロック対象サイトを表示している、または以前表示したタブを見つけます。再ロックのときにそのタブをロック画面に置き換え、ロック解除のあとはロック画面のタブを元のサイトに戻し、ロック中は `chrome://extensions` の代わりにロック画面を表示します（ユーザーがオフにできる保護機能）。 |
| サイトへのアクセス（任意、`*://*/*`） | インストール時には何も許可されません。ユーザーがサイトを追加すると、そのサイトとサブドメインへのアクセスだけを求めます。Chrome は、このアクセスがあるときだけ、そのサイトのページをロック画面へ送れます。アクセスがなくてもサイトはブロックされますが、Chrome のブロック画面が表示されます。 |

### リモートコード

使いません。コードはすべて拡張機能のパッケージの中にあり、ほかの場所からコードを読み込むことはありません。

### データの使用

- 収集するデータ：ありません。一覧にあるどの種類のデータも収集・送信せず、ネットワーク通信もしません。
- この端末にだけ保存するもの：パスワードのハッシュ、サイトの一覧、設定（上の `storage` の項目を参照）
- 確認事項：データを第三者に販売・譲渡せず、単一用途と関係のないことに使わず、信用力の判断や融資の目的にも使いません。
