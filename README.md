# Yu-Gi-Oh! Rush Duel Database in English
Warning! AI slop! But it works!

Userscript that replaces Japanese Rush Duel card/deck data on Konami Rush DB pages with English data from the hosted database exported from [Yugipedia.com](https://yugipedia.com/wiki/Yugipedia), with [Yugipedia](https://yugipedia.com/wiki/Yugipedia) itself as a fallback.

## Features

* Translates card details, card lists, decks, and search labels
* Uses cached English card data
* Toggle translation on/off
* Optional deck category/tag sorting
* Export deck pages to .ydk files or copy them as ydke:// URLs

## Install

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open [`yugioh-rush-database-english.user.js (click here)`](https://github.com/TrainStream/Yu-Gi-Oh-Rush-Database-English/releases/download/0.3/yugioh-rush-database-english.user.js) from this repo and click **Install**.

[Check out my EDOPro Standard/Rush HD Pics Downloader!](https://github.com/TrainStream/EDOPro-Standard-Rush-HD-Pics-Downloader)

## Supported pages

* [`db.yugioh-card.com/rushdb/card_search.action`](https://www.db.yugioh-card.com/rushdb/card_search.action)
* including any individual card page or booster pack list
* [`db.yugioh-card.com/rushdb/deck_search.action`](https://www.db.yugioh-card.com/rushdb/deck_search.action?request_locale=ja)
* `db.yugioh-card.com/rushdb/member_deck.action` (any user uploaded deck list from the above page)
* [`db.yugioh-card.com/rushdb/forbidden_limited.action`](https://www.db.yugioh-card.com/rushdb/forbidden_limited.action)

## Future Plans
Proper manual translation of the "Registered Category" card archetypes in the deck search page.
Currently it is mostly automated and many names are wrong.

<img width="980" height="934" alt="image" src="https://github.com/user-attachments/assets/2fe3c1b0-5263-48db-92cb-565a6437c766" />
<img width="976" height="773" alt="image" src="https://github.com/user-attachments/assets/a82aa835-f019-4d5e-a2b2-cfba2270915b" />
<img width="980" height="1112" alt="image" src="https://github.com/user-attachments/assets/713f1542-82ef-4963-825f-1ec98daab695" />

