// ==UserScript==
// @name         Yu-Gi-Oh! Rush Database English
// @namespace    local.rushdb.yugipedia-english
// @version      0.3.0
// @description  Replaces Japanese Rush Duel card details on Konami card pages with English data from the hosted database, falling back to Yugipedia.
// @author	 TrainStream
// Written with Codex assistance.
// @license	 https://github.com/TrainStream/Yu-Gi-Oh-Rush-Database-English/blob/main/LICENSE
// @match        https://www.db.yugioh-card.com/rushdb/
// @match        https://www.db.yugioh-card.com/rushdb/*
// @match        https://www.db.yugioh-card.com/rushdb/card_search.action*
// @match        https://www.db.yugioh-card.com/rushdb/deck_search.action*
// @match        https://www.db.yugioh-card.com/rushdb/member_deck.action*
// @connect      api.github.com
// @connect      raw.githubusercontent.com
// @connect      yugipedia.com
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.getValue
// @grant        GM.setValue
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/TrainStream/Yu-Gi-Oh-Rush-Database-English/main/yugioh-rush-database-english.meta.js
// @downloadURL  https://raw.githubusercontent.com/TrainStream/Yu-Gi-Oh-Rush-Database-English/main/yugioh-rush-database-english.user.js
// ==/UserScript==