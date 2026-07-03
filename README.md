# Yu-Gi-Oh! Rush Duel Database in English

Userscript that replaces Japanese Rush Duel card/deck data on Konami Rush DB pages with English data from the hosted database, with Yugipedia fallback.

## Features

* Translates card details, card lists, decks, and search labels
* Uses cached English card data
* Toggle translation on/off
* Optional deck category/tag sorting
* Release update notice

## Install

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open `yugioh-rush-database-english.user.js (click here)` from this repo and click **Install**.

## Supported pages

* [`db.yugioh-card.com/rushdb/card_search.action`](https://www.db.yugioh-card.com/rushdb/card_search.action)
* including any individual card page or booster pack list
* [`db.yugioh-card.com/rushdb/deck_search.action`](https://www.db.yugioh-card.com/rushdb/deck_search.action?request_locale=ja)
* `db.yugioh-card.com/rushdb/member_deck.action` (any user uploaded deck from the above page)
* [`db.yugioh-card.com/rushdb/forbidden_limited.action`](https://www.db.yugioh-card.com/rushdb/forbidden_limited.action)

## Future Plans
Proper manual translation of the "Registered Category" card archetypes in the deck search page.
Currently it is mostly automated and many names are wrong.
