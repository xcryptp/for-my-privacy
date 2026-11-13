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
- Paste a site such as instagram.com, or any full link, and the site and every address under it (www.instagram.com, help.instagram.com, a.b.instagram.com) show a lock screen instead of the page. A link to a blog on a big site locks the whole site (a Naver blog link locks all of naver.com). Look-alike names such as notinstagram.com are left alone.
- One password opens your locked sites and the settings page. They unlock separately: the lock screen opens sites, and the settings ask again. The password is stored only as a salted PBKDF2-SHA256 hash and cannot be recovered. If you forget it, remove the extension and install it again.
- Choose how far one unlock reaches: every locked site together (the default) or only the site you unlocked.
- It locks again by itself: after 1 to 60 minutes without keyboard or mouse input (5 by default), when the screen locks (you can switch this off), when the last Chrome window closes, and when Chrome restarts.
- Quick lock: the toolbar button "Lock now" and the keyboard shortcut Alt+Shift+L lock everything at once without a password. You can change the shortcut at chrome://extensions/shortcuts.
- When it locks again, open tabs of locked sites turn into the lock screen, and Back does not bring the old page back. A locked site shown inside another page is blocked, and that page is reloaded. The sites' own service workers and caches are removed, so a site cannot answer from its saved copy. Cookies and logins are left alone.
- The lock screen says how many tries are left. After 5 wrong passwords a wait starts at 30 seconds and doubles with each try, up to 15 minutes.
- A four-step setup on first run, with one-tap choices for common sites, and help on the lock screen if you forget the password.
- The lock screen shows the site's name, not the address of the page you tried to open.
- Screens in English, Korean and Japanese.

Chrome's extensions page is guarded too
While your sites are locked, opening Chrome's extensions page (chrome://extensions) shows the lock screen and asks for the password, so the extension cannot simply be switched off there. This is on by default. You can turn it off in Settings, under Security, with "Ask for the password before Chrome's extensions page opens". Chrome still lets anyone remove an extension from the toolbar menu; the README explains optional Chrome policies that stop that.

Why Chrome shows these notices
Chrome shows the declarativeNetRequest permission as "Block content on any page". For My Privacy uses it only for the sites you add. It needs this permission so that a locked site stays blocked even if its site access is later withdrawn from the toolbar menu; the site then shows Chrome's blocked page, never its content. Chrome shows the tabs and webNavigation permissions as "Read your browsing history". The extension uses them only to find tabs and frames that show a locked site and to put the lock screen there. It compares addresses with your list and sends nothing anywhere.

Private
Nothing is collected or sent. No network requests, no analytics, no account. The password hash, your site list, your settings and a few addresses of locked sites' subdomains (to remove their saved workers and caches) and the page address each lock screen will open after you unlock (until you unlock or that tab closes) stay in Chrome's storage on your computer.

What it does not stop: a person who controls your computer, for example its administrator, or someone using Chrome DevTools, starting Chrome with extensions off or editing Chrome's profile files. A locked site's saved page can show for a split second in some cases, and page titles stay in Chrome's history. Any website can also find out that the extension is installed, because the lock page is web-accessible. The README lists these limits.

Open source (MIT): https://github.com/xcryptp/for-my-privacy

### Single purpose

Lock the websites the user chooses behind a password, and lock them again when the user steps away.

### Permission justifications

| Permission | Justification |
| --- | --- |
| `declarativeNetRequest` | Holds the rules that send page requests for the sites the user locked to the extension's lock page, block those sites inside frames and for every other kind of request, and let them through for the rest of the browser session after the right password. The rules list only the user's sites. |
| `storage` | Keeps these in `chrome.storage.local` on the device: the password hash and the wrong-try count and wait; the list of locked sites and the settings (including how far one unlock reaches); the origins of locked sites' subdomains that tabs or frames showed (kept across sessions so their service workers can be removed, and dropped when a site leaves the list); the page address each lock screen that the extension opened itself will open after unlocking (kept so the lock screen survives a Chrome restart or an update; deleted when the user unlocks, when that tab closes, and at the next lock for any tab that is gone); and the first-run setup progress until it is finished. While Chrome runs, `chrome.storage.session` also holds the time the screen locked, the IDs of tabs that showed a locked site or embedded one in a frame, whether the settings and the extensions page are unlocked, and the page address each lock screen will open after unlocking; Chrome clears it when it closes. Nothing leaves the device. |
| `idle` | Notices when there has been no keyboard or mouse input for the chosen number of minutes, and when the screen locks, so the sites lock again. |
| `tabs` | Reads tab addresses to find tabs that show, or earlier showed, a locked site; replaces them with the lock page when the lock comes back or when a locked page loaded anyway; sends lock pages back to their site after unlocking; and shows the lock page instead of `chrome://extensions` while locked (the guard, which the user can turn off). |
| `webNavigation` | Sees the frames of a page, so a locked site embedded in another page is found: when the lock comes back, the page that embeds it is reloaded, and a frame of a locked site that still loads while locked is dealt with. Chrome shows the same "Read your browsing history" notice as for `tabs`. |
| `browsingData` | Removes the service workers and cache storage (nothing else) of the locked sites each time the lock comes back, when Chrome starts and when a site is newly locked. A site's own service worker can show its saved page without the request reaching the blocking rules; removing it closes that gap. Cookies, logins and other site data are never removed. Chrome shows no notice for this permission. |
| Host access, optional (`*://*/*`) | Nothing is granted at install. When the user adds a site, the extension asks for access to that one site and every address under it. Chrome needs it to send that site's pages to the lock page; without it the site is still blocked, but shows Chrome's blocked page for a moment instead. |

The manifest also declares one keyboard command, `lock-now` (suggested key Alt+Shift+L), and a toolbar popup with two buttons, "Lock now" and "Open settings". Neither needs a permission.

### Remote code

No. All code is inside the extension package; nothing is loaded from anywhere else.

### Data use

- Collected data: none. The extension does not collect or send any of the listed kinds of data; it makes no network requests.
- Stored on the device only: the password hash, the site list, the settings, the wrong-try count and the origins of locked sites' subdomains that tabs showed, and the address a lock screen opened by the extension will open after unlocking (see the storage justification above).
- Certifications: the data is not sold or transferred to third parties, not used for anything unrelated to the single purpose, and not used to decide creditworthiness or for lending.

## 한국어

### 간단한 설명(49자)

선택한 사이트와 그 하위 주소를 모두 비밀번호로 잠급니다. 자리를 비우면 다시 잠깁니다.

### 자세한 설명

For My Privacy는 내가 고른 웹사이트에 비밀번호를 겁니다. 막으려는 상황은 하나입니다. 자리를 비운 사이, 로그인된 내 크롬 앞에 다른 사람이 앉는 것입니다.

하는 일
- instagram.com 같은 사이트나 전체 주소를 붙여 넣으면 그 사이트와 그 아래의 모든 주소(www.instagram.com, help.instagram.com, a.b.instagram.com)에서 페이지 대신 잠금 화면이 뜹니다. 큰 사이트 안의 블로그 주소를 넣으면 사이트 전체가 잠깁니다(네이버 블로그 주소를 넣으면 naver.com 전체). notinstagram.com처럼 이름만 비슷한 사이트는 건드리지 않습니다.
- 비밀번호 하나로 잠긴 사이트와 설정 화면이 열리며, 푸는 곳은 따로입니다. 잠금 화면에서는 사이트가 열리고, 설정은 비밀번호를 한 번 더 묻습니다. 비밀번호는 salt를 쓴 PBKDF2-SHA256 해시로만 저장되며 되살릴 수 없습니다. 잊으면 확장 프로그램을 삭제하고 다시 설치하세요.
- 한 번 푸는 범위를 고를 수 있습니다. 잠긴 사이트를 모두 함께 풀기(기본값)와 푼 사이트만 풀기가 있습니다.
- 알아서 다시 잠깁니다. 키보드·마우스 입력이 1-60분(기본 5분) 동안 없을 때, 화면이 잠길 때(끌 수 있음), 마지막 크롬 창을 닫을 때, 크롬을 다시 켤 때입니다.
- 빠른 잠금: 툴바 버튼 "지금 잠그기"와 단축키 Alt+Shift+L로 비밀번호 없이 한 번에 모두 잠급니다. 단축키는 chrome://extensions/shortcuts에서 바꿀 수 있습니다.
- 다시 잠길 때 열려 있던 잠긴 사이트의 탭은 잠금 화면으로 바뀌고, 뒤로 가기를 눌러도 원래 페이지가 다시 보이지 않습니다. 다른 페이지 안에 끼워 넣은 잠긴 사이트는 막히고, 그 페이지는 새로 고쳐집니다. 사이트 자체의 서비스 워커와 캐시를 지우므로, 사이트가 저장해 둔 사본으로 대신 답할 수 없습니다. 쿠키와 로그인은 건드리지 않습니다.
- 잠금 화면에 남은 시도 횟수가 나옵니다. 5번 틀리면 30초부터 시작해 시도할 때마다 두 배로 늘어나는 대기 시간이 생기며, 최대 15분입니다.
- 처음 실행할 때는 4단계 설정이 있고, 자주 쓰는 사이트는 한 번에 고를 수 있습니다. 비밀번호를 잊었을 때의 안내가 잠금 화면에 있습니다.
- 잠금 화면에는 열려던 페이지 주소가 아니라 사이트 이름만 나옵니다.
- 한국어·영어·일본어 화면을 지원합니다.

크롬 확장 프로그램 페이지도 지킵니다
사이트가 잠겨 있는 동안 크롬 확장 프로그램 페이지(chrome://extensions)를 열면 잠금 화면이 뜨고 비밀번호를 묻습니다. 그래서 그 페이지에서 확장 프로그램을 간단히 끌 수 없습니다. 기본으로 켜져 있고, 설정의 보안 메뉴에서 "Chrome 확장 프로그램 페이지를 열기 전에 비밀번호 묻기"로 끌 수 있습니다. 툴바 메뉴에서 확장 프로그램을 삭제하는 것은 크롬이 누구에게나 허용하므로 막지 못합니다. 이를 막는 크롬 정책(선택)은 README에 설명해 두었습니다.

크롬이 이런 안내를 띄우는 이유
크롬은 declarativeNetRequest 권한을 "모든 페이지의 콘텐츠 차단"이라고 표시합니다. For My Privacy는 이 권한을 내가 추가한 사이트에만 씁니다. 나중에 툴바 메뉴에서 사이트 접근 권한이 빠져도 잠긴 사이트를 계속 막으려면 이 권한이 필요합니다. 그때 그 사이트에는 내용 대신 크롬의 차단 화면이 뜹니다. 크롬은 tabs와 webNavigation 권한을 "Read your browsing history"(방문 기록 읽기)로 표시합니다. 이 권한은 잠긴 사이트를 보여 주는 탭과 프레임을 찾아 그 자리에 잠금 화면을 띄우는 데만 씁니다. 주소를 내 목록과 견주기만 하고 어디로도 보내지 않습니다.

개인정보
아무것도 수집하거나 보내지 않습니다. 네트워크 요청도, 분석 도구도, 계정도 없습니다. 비밀번호 해시, 사이트 목록, 설정, 그리고 저장된 서비스 워커와 캐시를 지우기 위한 잠금 사이트 하위 주소 몇 개, 잠금 화면이 잠금을 푼 뒤 열 페이지의 주소(잠금을 풀거나 그 탭을 닫을 때까지)는 내 컴퓨터의 크롬 저장 공간에만 남습니다.

막지 못하는 것: 컴퓨터 자체를 장악한 사람입니다. 예를 들어 컴퓨터 관리자, 크롬 개발자 도구를 쓰는 사람, 확장 프로그램을 끄고 크롬을 실행하는 사람, 크롬 프로필 파일을 고치는 사람입니다. 경우에 따라 잠긴 사이트의 저장된 페이지가 잠깐 보일 수 있고, 페이지 제목은 크롬 방문 기록에 남습니다. 잠금 화면이 웹에서 접근할 수 있는 페이지라서, 어떤 웹사이트든 이 확장 프로그램이 설치된 것은 알아낼 수 있습니다. 자세한 한계는 README에 있습니다.

오픈소스(MIT): https://github.com/xcryptp/for-my-privacy

### 단일 목적

사용자가 고른 웹사이트를 비밀번호로 잠그고, 사용자가 자리를 비우면 다시 잠급니다.

### 권한이 필요한 이유

| 권한 | 이유 |
| --- | --- |
| `declarativeNetRequest` | 사용자가 잠근 사이트의 페이지 요청을 확장 프로그램의 잠금 화면으로 보내고, 다른 페이지에 끼워 넣은 그 사이트와 그 밖의 모든 종류의 요청을 막고, 비밀번호가 맞으면 브라우저를 끌 때까지 통과시키는 규칙을 둡니다. 규칙에는 사용자가 추가한 사이트만 들어갑니다. |
| `storage` | 아래 내용을 이 기기의 `chrome.storage.local`에 보관합니다. 비밀번호 해시와 틀린 횟수·대기 시간, 잠긴 사이트 목록과 설정(한 번 푸는 범위 포함), 탭이나 프레임이 보여 준 잠긴 사이트 하위 주소의 출처(서비스 워커를 지우려고 세션을 넘겨 보관하며, 사이트가 목록에서 빠지면 지움), 확장 프로그램이 직접 연 잠금 화면마다 잠금을 푼 뒤 열 페이지의 주소(크롬을 다시 시작하거나 업데이트해도 잠금 화면이 이어지도록 보관하며, 잠금을 풀거나 그 탭을 닫을 때, 없어진 탭의 것은 다음 잠금 때 지움), 끝나기 전까지의 처음 실행 설정 진행 상태입니다. 크롬이 켜져 있는 동안에는 화면이 잠긴 시각, 잠긴 사이트를 보여 주거나 프레임으로 넣은 탭의 ID, 설정과 확장 프로그램 페이지가 풀려 있는지, 잠금 화면마다 잠금을 푼 뒤 열 페이지의 주소도 `chrome.storage.session`에 두며, 크롬을 끄면 지워집니다. 기기 밖으로 나가는 것은 없습니다. |
| `idle` | 정한 시간 동안 키보드·마우스 입력이 없을 때와 화면이 잠길 때를 알아차려 사이트를 다시 잠급니다. |
| `tabs` | 탭 주소를 읽어 잠긴 사이트를 보여 주고 있거나 전에 보여 준 탭을 찾고, 다시 잠길 때나 잠긴 페이지가 그래도 로드됐을 때 그 탭을 잠금 화면으로 바꾸고, 잠금을 풀면 잠금 화면 탭을 원래 사이트로 돌려보내고, 잠긴 동안 `chrome://extensions` 대신 잠금 화면을 띄웁니다(사용자가 끌 수 있는 보호 기능). |
| `webNavigation` | 페이지의 프레임을 볼 수 있어, 다른 페이지에 끼워 넣은 잠긴 사이트를 찾습니다. 다시 잠길 때 그 사이트를 끼워 넣은 페이지를 새로 고치고, 잠겨 있는 동안에도 로드되는 잠긴 사이트의 프레임을 처리합니다. 크롬이 `tabs`와 같은 "Read your browsing history" 안내를 띄웁니다. |
| `browsingData` | 다시 잠길 때마다, 크롬을 켤 때, 사이트를 새로 잠글 때 잠긴 사이트의 서비스 워커와 캐시 저장소(그 밖의 것은 아님)를 지웁니다. 사이트 자체의 서비스 워커는 요청이 차단 규칙에 닿지 않아도 저장된 페이지를 보여 줄 수 있어서, 이를 지워 빈틈을 막습니다. 쿠키, 로그인, 그 밖의 사이트 데이터는 지우지 않습니다. 크롬은 이 권한에 안내를 띄우지 않습니다. |
| 사이트 접근(선택, `*://*/*`) | 설치할 때는 아무 접근도 받지 않습니다. 사용자가 사이트를 추가하면 그 사이트와 그 아래의 모든 주소에 대한 접근만 요청합니다. 크롬은 이 접근이 있어야 그 사이트의 페이지를 잠금 화면으로 보낼 수 있습니다. 접근이 없으면 사이트는 여전히 막히지만 크롬의 차단 화면이 잠깐 뜹니다. |

매니페스트에는 키보드 명령 `lock-now`(기본 단축키 Alt+Shift+L)와, "지금 잠그기"와 "설정 열기" 두 버튼이 있는 툴바 팝업도 있습니다. 둘 다 권한이 필요하지 않습니다.

### 원격 코드

사용하지 않습니다. 모든 코드는 확장 프로그램 패키지 안에 있으며, 다른 곳에서 가져오는 코드는 없습니다.

### 데이터 사용

- 수집하는 데이터: 없습니다. 목록의 어떤 종류의 데이터도 수집하거나 보내지 않으며, 네트워크 요청을 하지 않습니다.
- 이 기기에만 저장하는 것: 비밀번호 해시, 사이트 목록, 설정, 틀린 횟수, 탭이 보여 준 잠긴 사이트 하위 주소의 출처, 확장 프로그램이 연 잠금 화面이 잠금을 푼 뒤 열 페이지의 주소(위 `storage` 항목 참고)
- 확인 사항: 데이터를 제3자에게 팔거나 넘기지 않고, 단일 목적과 관계없는 일에 쓰지 않으며, 신용도 판단이나 대출 목적으로 쓰지 않습니다.

## 日本語

### 簡単な説明（54文字）

選んだサイトとそのサブドメインをすべてパスワードでロックします。席を離れると、自動でもう一度ロックされます。

### 詳しい説明

For My Privacy は、あなたが選んだウェブサイトにパスワードをかけます。想定している状況は1つです。席を離れている間に、ログイン済みのあなたの Chrome の前に別の人が座ることです。

できること
- instagram.com のようなサイトや完全なアドレスを貼り付けると、そのサイトとその下にあるすべてのアドレス（www.instagram.com、help.instagram.com、a.b.instagram.com）で、ページの代わりにロック画面が表示されます。大きなサイトの中のブログのアドレスを貼ると、サイト全体がロックされます（Naver のブログのアドレスなら naver.com 全体）。notinstagram.com のように名前が似ているだけのサイトには手を出しません。
- 1つのパスワードで、ロックされたサイトと設定画面が開きます。解除する場所は別々で、ロック画面ではサイトが開き、設定ではもう一度パスワードを聞かれます。パスワードは salt 付きの PBKDF2-SHA256 ハッシュとしてのみ保存され、元に戻すことはできません。忘れた場合は、拡張機能を削除してインストールし直してください。
- 1回の解除の範囲を選べます。ロックしたサイトをすべていっしょに解除する（初期設定）か、解除したサイトだけを解除するかです。
- 自動でまたロックします。キーボードやマウスの操作が1-60分（初期設定は5分）ないとき、画面がロックされたとき（オフにできます）、最後の Chrome ウィンドウを閉じたとき、Chrome を起動し直したときです。
- クイックロック：ツールバーのボタン「今すぐロック」とショートカットキー Alt+Shift+L で、パスワードなしでまとめてロックします。ショートカットは chrome://extensions/shortcuts で変更できます。
- 再ロックのとき、開いているロック対象サイトのタブはロック画面に切り替わり、「戻る」を押しても元のページは表示されません。ほかのページに埋め込まれたロック対象サイトはブロックされ、そのページは再読み込みされます。サイト自身のサービスワーカーとキャッシュを消すので、サイトが保存済みのコピーで代わりに応答することはできません。Cookie とログインには手をつけません。
- ロック画面に、残りの試行回数が表示されます。5回間違えると、30秒から始まり、試すたびに2倍になる待ち時間が入り、最大15分です。
- 初回は4ステップのセットアップがあり、よく使うサイトはワンタップで選べます。パスワードを忘れたときの案内は、ロック画面にあります。
- ロック画面には、開こうとしたページのアドレスではなく、サイトの名前だけが表示されます。
- 日本語・英語・韓国語の画面に対応しています。

Chrome の拡張機能ページも守ります
サイトがロックされている間に Chrome の拡張機能ページ（chrome://extensions）を開くと、ロック画面が表示され、パスワードを求めます。そのため、このページで拡張機能を簡単にオフにすることはできません。初期設定でオンになっており、設定のセキュリティで「Chromeの拡張機能ページを開く前にパスワードを求める」をオフにできます。ツールバーのメニューから拡張機能を削除することは、Chrome が誰にでも許しているため防げません。これを防ぐ Chrome のポリシー（任意）は README で説明しています。

Chrome がこれらの通知を表示する理由
Chrome は declarativeNetRequest 権限を「あらゆるページのコンテンツをブロック」と表示します。For My Privacy がこの権限を使うのは、あなたが追加したサイトだけです。あとでツールバーのメニューからサイトへのアクセス権が外されても、ロック対象サイトをブロックし続けるために、この権限が必要です。そのときサイトには、中身の代わりに Chrome のブロック画面が表示されます。Chrome は tabs 権限と webNavigation 権限を「Read your browsing history」（閲覧履歴の読み取り）と表示します。これらの権限は、ロック対象サイトを表示しているタブやフレームを見つけて、そこにロック画面を表示するためだけに使います。アドレスをあなたの一覧と照らし合わせるだけで、どこにも送りません。

プライバシー
何も集めず、何も送りません。ネットワーク通信も、分析ツールも、アカウントもありません。パスワードのハッシュ、サイトの一覧、設定、そして保存済みのサービスワーカーとキャッシュを消すためのロック対象サイトのサブドメインのアドレス数件、ロック画面が解除後に開くページのアドレス（解除するか、そのタブを閉じるまで）は、あなたのパソコンの Chrome の保存領域にだけ残ります。

防げないこと：パソコンそのものを自由に操作できる人です。たとえばパソコンの管理者、Chrome のデベロッパーツールを使う人、拡張機能をオフにして Chrome を起動する人、Chrome のプロファイルファイルを書き換える人です。場合によっては、ロック対象サイトの保存済みのページが一瞬見えることがあり、ページのタイトルは Chrome の履歴に残ります。ロック画面はウェブから参照できるページなので、どのウェブサイトでも、この拡張機能が入っていることは調べられます。詳しい限界は README にあります。

オープンソース（MIT）：https://github.com/xcryptp/for-my-privacy

### 単一用途

ユーザーが選んだウェブサイトをパスワードでロックし、ユーザーが席を離れたらもう一度ロックします。

### 権限が必要な理由

| 権限 | 理由 |
| --- | --- |
| `declarativeNetRequest` | ユーザーがロックしたサイトのページへのリクエストを拡張機能のロック画面へ送り、ほかのページに埋め込まれたそのサイトとそれ以外のあらゆる種類のリクエストをブロックし、正しいパスワードのあとはブラウザを閉じるまで通す規則を置きます。規則に入るのは、ユーザーが追加したサイトだけです。 |
| `storage` | 次の内容を、この端末の `chrome.storage.local` に保存します。パスワードのハッシュと、間違えた回数・待ち時間、ロック対象サイトの一覧と設定（1回の解除の範囲を含む）、タブやフレームが表示したロック対象サイトのサブドメインのオリジン（サービスワーカーを消すためにセッションをまたいで保存し、サイトが一覧から外れると削除）、再ロックのときに拡張機能が自分で開いたロック画面ごとの、解除後に開くページのアドレス（Chrome の再起動や更新のあとでもロック画面が続くように保存し、解除したとき、そのタブを閉じたとき、なくなったタブの分は次のロックのときに削除）、終わるまでの初回セットアップの進み具合です。Chrome の起動中は、画面がロックされた時刻、ロック対象サイトを表示した、またはフレームで含んだタブの ID、設定と拡張機能ページが解除されているかどうか、ロック画面ごとの解除後に開くページのアドレスも `chrome.storage.session` に置きます。これは Chrome を閉じると消えます。端末の外に出るものはありません。 |
| `idle` | 決めた時間キーボードやマウスの操作がないとき、そして画面がロックされたときに気づき、サイトをもう一度ロックします。 |
| `tabs` | タブのアドレスを読んで、ロック対象サイトを表示している、または以前表示したタブを見つけます。再ロックのとき、またはロック対象のページがそれでも読み込まれたときに、そのタブをロック画面に置き換え、ロック解除のあとはロック画面のタブを元のサイトに戻し、ロック中は `chrome://extensions` の代わりにロック画面を表示します（ユーザーがオフにできる保護機能）。 |
| `webNavigation` | ページのフレームを見ることができ、ほかのページに埋め込まれたロック対象サイトを見つけます。再ロックのときにそのサイトを埋め込んだページを再読み込みし、ロック中にも読み込まれるロック対象サイトのフレームを処理します。Chrome は、`tabs` と同じ「Read your browsing history」の通知を表示します。 |
| `browsingData` | 再ロックのたび、Chrome の起動時、サイトを新しくロックしたときに、ロック対象サイトのサービスワーカーとキャッシュストレージ（それ以外は対象外）を消します。サイト自身のサービスワーカーは、リクエストがブロック規則に届かなくても保存済みのページを表示できるため、それを消して抜け道をふさぎます。Cookie、ログイン、そのほかのサイトのデータは消しません。Chrome はこの権限に通知を表示しません。 |
| サイトへのアクセス（任意、`*://*/*`） | インストール時には何も許可されません。ユーザーがサイトを追加すると、そのサイトとその下にあるすべてのアドレスへのアクセスだけを求めます。Chrome は、このアクセスがあるときだけ、そのサイトのページをロック画面へ送れます。アクセスがなくてもサイトはブロックされますが、Chrome のブロック画面が一瞬表示されます。 |

マニフェストには、キーボードコマンド `lock-now`（初期のショートカットは Alt+Shift+L）と、「今すぐロック」と「設定を開く」の2つのボタンがあるツールバーのポップアップもあります。どちらも権限は必要ありません。

### リモートコード

使いません。コードはすべて拡張機能のパッケージの中にあり、ほかの場所からコードを読み込むことはありません。

### データの使用

- 収集するデータ：ありません。一覧にあるどの種類のデータも収集・送信せず、ネットワーク通信もしません。
- この端末にだけ保存するもの：パスワードのハッシュ、サイトの一覧、設定、間違えた回数、タブが表示したロック対象サイトのサブドメインのオリジン、拡張機能が開いたロック画面が解除後に開くページのアドレス（上の `storage` の項目を参照）
- 確認事項：データを第三者に販売・譲渡せず、単一用途と関係のないことに使わず、信用力の判断や融資の目的にも使いません。
