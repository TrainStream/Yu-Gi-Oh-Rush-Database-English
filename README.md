# Yu-Gi-Oh! Rush Duel Database in English
Warning! AI slop! But it works!

Userscript that replaces Japanese Rush Duel card/deck data on the official database with English data from [Yugipedia.com](https://yugipedia.com/wiki/Yugipedia)

## Features

* Translates card details, card lists, decks, and search labels
* Uses cached English card data
* Toggle translation on/off
* Optional alphabetical sorting for the translated deck category/tag labels on the deck search page 
* Export deck pages to EDOPro .ydk files or copy them as ydke:// URLs (card id database hosted in this repository) 
* This repository hosts an exported Yugipedia card database. The script checks it first, then falls back to Yugipedia for missing cards. This is because Yugipedia is often unstable.
* Added experimental Google Translate controls for deck titles and comments (disabled by default).
  * On the deck search and deck pages. It takes some time.
  * Opens a Google Translate tab in the browser and closes it when the translation is complete.

**Note:** If you enable your browser's automatic translation, this script's card effect and label translations will likely take priority, so they won't be translated again. I recommend using your browser's translation instead of the experimental Google Translate feature, though the experimental option seems to work reasonably well.

## Install

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open [`yugioh-rush-database-english.user.js (click here)`](https://github.com/TrainStream/Yu-Gi-Oh-Rush-Database-English/releases/download/0.3.1/yugioh-rush-database-english.user.js) from this repo and click **Install**.

[Check out my EDOPro Standard/Rush HD Pics Downloader!](https://github.com/TrainStream/EDOPro-Standard-Rush-HD-Pics-Downloader)

## Supported pages

* [`db.yugioh-card.com/rushdb/card_search.action`](https://www.db.yugioh-card.com/rushdb/card_search.action)
* including any individual card page or booster pack list
* [`db.yugioh-card.com/rushdb/deck_search.action`](https://www.db.yugioh-card.com/rushdb/deck_search.action?request_locale=ja)
* `db.yugioh-card.com/rushdb/member_deck.action` (any user uploaded deck list from the above page)
* [`db.yugioh-card.com/rushdb/forbidden_limited.action`](https://www.db.yugioh-card.com/rushdb/forbidden_limited.action)

<img width="971" height="940" alt="image" src="https://github.com/user-attachments/assets/9cb22a4b-2a08-4f11-9bdf-94351b9d05ef" />
<img width="976" height="773" alt="image" src="https://github.com/user-attachments/assets/a82aa835-f019-4d5e-a2b2-cfba2270915b" />

