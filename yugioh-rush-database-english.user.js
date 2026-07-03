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

(function () {
  "use strict";

  const API = "https://yugipedia.com/api.php";
  const HOSTED_DATABASE_URL = "https://raw.githubusercontent.com/TrainStream/Yu-Gi-Oh-Rush-Database-English/main/Database/rush_yugipedia_english.json";
  const RELEASES_API_URL = "https://api.github.com/repos/TrainStream/Yu-Gi-Oh-Rush-Database-English/releases";
  const RELEASES_PAGE_URL = "https://github.com/TrainStream/Yu-Gi-Oh-Rush-Database-English/releases";
  const SCRIPT_VERSION = "0.2.0";
  const CACHE_PREFIX = "rushdb-yugipedia-english:";
  const ENABLED_KEY = "rushdb-yugipedia-english:enabled";
  const SORT_CATEGORIES_KEY = "rushdb-yugipedia-english:sort-categories";
  const CONTROLS_MINIMIZED_KEY = "rushdb-yugipedia-english:controls-minimized";
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const CACHE_MAX_CARDS = 5000;
  const CARD_LOOKUP_PARALLELISM = 4;
  const CARD_LOOKUP_FINAL_PARALLELISM = 3;
  const CARD_LOOKUP_RETRY_COUNT = 3;
  const CARD_LOOKUP_RETRY_DELAYS = [1200, 3000, 7000];
  const CARD_LOOKUP_FINAL_RETRY_DELAYS = [1500, 4000];
  const CARD_LOOKUP_BACKGROUND_RETRY_DELAYS = [15000, 45000, 120000];
  const CARD_LOOKUP_BATCH_TIMEOUT_MS = 10000;
  const CARD_LOOKUP_FINAL_TIMEOUT_MS = 15000;
  const CARD_LOOKUP_DETAIL_TIMEOUT_MS = 20000;
  const HOSTED_DATABASE_TIMEOUT_MS = 30000;
  const CARD_LOOKUP_TIMEOUT_BUFFER_MS = 3000;
  const EDOPRO_RUSH_CARD_IDS_XLSX_URL = "https://raw.githubusercontent.com/TrainStream/Yu-Gi-Oh-Rush-Database-English/main/Database/edopro-rush-card-ids.xlsx";
  const params = new URLSearchParams(location.search);
  const cid = params.get("cid");
  const ope = params.get("ope");
  const isCardDetailPage = location.pathname.endsWith("/card_search.action") && cid && ope === "2";
  const isCardListPage = location.pathname.endsWith("/card_search.action") && ope === "1";
  const isCardSearchPage = location.pathname.endsWith("/card_search.action") && !cid && ope !== "1" && ope !== "2";
  const isDeckSearchPage = location.pathname.endsWith("/deck_search.action");
  const isDeckPage = location.pathname.endsWith("/member_deck.action") && ope === "1";
  const isForbiddenLimitedPage = location.pathname.endsWith("/forbidden_limited.action");
  const isLabelOnlyPage = isDeckSearchPage || isCardSearchPage || isForbiddenLimitedPage;
  const isKnownRushDbTranslationPage = isCardDetailPage || isCardListPage || isCardSearchPage || isDeckSearchPage || isDeckPage || isForbiddenLimitedPage;
  const originalData = isCardDetailPage ? captureOriginalData() : null;
  const deckOriginals = new Map();
  const inFlightCardLookups = new Map();
  let hostedDatabasePromise = null;
  let edoproRushCardsPromise = null;
  let deckYdkeCopyState = null;

  function forceVersionNoticeForTesting() {
    return false;
  }

  if (!location.pathname.startsWith("/rushdb/")) {
    return;
  }

  main().catch((error) => {
    console.error("[RushDB Yugipedia English]", error);
    setStatus("Yugipedia English data failed to load.", true);
  });

  async function main() {
    translateRushDbGlobalHeaders();

    if (!isKnownRushDbTranslationPage) {
      return;
    }

    const enabled = await isTranslationEnabled();
    const sortCategories = isDeckSearchPage ? await isCategorySortingEnabled() : false;
    installToggleStyles();
    createToggle(enabled);
    if (isDeckSearchPage) {
      createCategorySortToggle(sortCategories);
      createDeleteCacheButton();
      updateCategorySortToggleAvailability(enabled, sortCategories);
      createVersionNotice();
    } else if (isCardSearchPage || isForbiddenLimitedPage) {
      createDeleteCacheButton();
      createVersionNotice();
    }
    await applyStoredSearchControlsMinimizedState();

    if (!enabled) {
      setStatus(isLabelOnlyPage ? "English translation is off." : "Yugipedia English translation is off.");
      return;
    }

    await translateCurrentTarget();
  }

  async function translateCurrentTarget() {
    if (isDeckPage) {
      await translateDeckPage();
      return;
    }

    if (isCardListPage) {
      await translateCardListPage();
      return;
    }

    if (isForbiddenLimitedPage) {
      await translateForbiddenLimitedPage();
      return;
    }

    if (isDeckSearchPage) {
      translateDeckSearchPage();
      return;
    }

    if (isCardSearchPage) {
      translateCardSearchPage();
      return;
    }

    await translateCardDetailPage();
  }

  function restoreCurrentTarget() {
    if (isDeckPage) {
      restoreDeckData();
      return;
    }

    if (isCardListPage) {
      restoreDeckData();
      return;
    }

    if (isDeckSearchPage) {
      restoreDeckSearchCategoryOrder();
      restoreDeckData();
      return;
    }

    if (isCardSearchPage) {
      restoreDeckData();
      return;
    }

    restoreOriginalData();
    restoreDeckData();
    setRelatedStatus("Related-card translation is off.");
  }

  async function translateCardDetailPage() {
    setStatus("Loading English data from hosted database...");
    let card = null;
    try {
      const result = await getCardDataWithRetry(cid, {
        retryDelays: CARD_LOOKUP_FINAL_RETRY_DELAYS,
        retryNullResults: true,
      });
      card = result.card;
    } catch (error) {
      console.warn("[RushDB Yugipedia English] Card lookup failed", cid, error);
      setStatus("Could not load English data from the hosted database or Yugipedia.", true);
      return;
    }

    if (!card) {
      setStatus("No matching hosted database or Yugipedia page found.", true);
      return;
    }

    applyEnglishData(card);
    setStatus(`English data loaded: ${card.title}`, false, card.url);
    await translateRelatedCards();
  }

  async function translateRelatedCards() {
    translateRelatedCardLabels();
    const cardIds = getRelatedCardIds();

    if (cardIds.length === 0) {
      return;
    }

    setRelatedStatus(`Loading related-card English data... 0/${cardIds.length}`);
    const cardsById = await getCardDataMap(cardIds, (completed, total, result, phase) => {
      const waitMessage = getRetryWaitMessage(result, "related-card");
      setRelatedStatus(waitMessage || (phase === "final-retry"
        ? `Retrying missing related cards... ${getLoadedCount(result, completed)}/${total}`
        : `Loading related-card English data... ${completed}/${total}`), false, result && result.retryNow);
    });
    const translatedRows = applyRelatedCardTranslations(cardsById);
    setRelatedStatus(`Translated ${translatedRows} related cards.`);
  }

  async function translateDeckPage() {
    translateLimitBadges();
    const translatedLabels = translateDeckStaticLabels();
    const deckYdkeEntries = getDeckYdkeEntries();
    const cardIds = getDeckCardIds();
    if (cardIds.length === 0) {
      deckYdkeCopyState = null;
      setStatus("No deck cards found to translate.", translatedLabels === 0);
      return;
    }

    setStatus(`Loading English data for deck... 0/${cardIds.length}`);
    let translatedRows = 0;
    const cardsById = await getDeckCardData(cardIds, (databaseId, card) => {
      translatedRows += applyDeckCardTranslation(databaseId, card);
    });
    deckYdkeCopyState = await getDeckYdkeCopyState(deckYdkeEntries, cardsById);
    setStatus(
      buildCardBatchStatus(`Translated ${translatedRows} deck rows (${cardsById.size}/${cardIds.length} unique cards).`, cardsById),
      hasFailedLookups(cardsById),
      null,
      buildRetryAction(cardsById, "deck", setStatus, (databaseId, card) => {
        translatedRows += applyDeckCardTranslation(databaseId, card);
      }, async (retryCardsById) => {
        retryCardsById.forEach((card, databaseId) => {
          cardsById.set(databaseId, card);
        });
        deckYdkeCopyState = await getDeckYdkeCopyState(deckYdkeEntries, cardsById);
        setStatus(
          buildCardBatchStatus(`Translated ${translatedRows} deck rows (${cardsById.size}/${cardIds.length} unique cards).`, retryCardsById),
          hasFailedLookups(retryCardsById),
          null,
          buildRetryAction(retryCardsById, "deck", setStatus, (databaseId, card) => {
            translatedRows += applyDeckCardTranslation(databaseId, card);
          })
        );
      })
    );
  }

  async function translateCardListPage() {
    translateLimitBadges();
    const translatedLabels = translateCardListStaticLabels();
    const cardIds = getCardListIds();
    if (cardIds.length === 0) {
      setStatus("No card-list cards found to translate.", translatedLabels === 0);
      return;
    }

    setStatus(`Loading English data for card list... 0/${cardIds.length}`);
    let translatedRows = 0;
    const cardsById = await getCardDataMap(cardIds, (completed, total, result, phase) => {
      const waitMessage = getRetryWaitMessage(result, "card-list");
      setStatus(waitMessage || (phase === "final-retry"
        ? `Retrying missing card-list cards... ${getLoadedCount(result, completed)}/${total}`
        : `Loading English data for card list... ${completed}/${total}`), false, null, result && result.retryNow);
    }, (databaseId, card) => {
      translatedRows += applyCardListCardTranslation(databaseId, card);
    });
    translateCardListHeader(cardsById);
    setStatus(
      buildCardBatchStatus(`Translated ${translatedRows} card-list rows (${cardsById.size}/${cardIds.length} unique cards).`, cardsById),
      hasFailedLookups(cardsById),
      null,
      buildRetryAction(cardsById, "card-list", setStatus, (databaseId, card) => {
        translatedRows += applyCardListCardTranslation(databaseId, card);
      }, (retryCardsById) => {
        translateCardListHeader(retryCardsById);
        setStatus(
          buildCardBatchStatus(`Translated ${translatedRows} card-list rows (${cardsById.size + retryCardsById.size}/${cardIds.length} unique cards).`, retryCardsById),
          hasFailedLookups(retryCardsById),
          null,
          buildRetryAction(retryCardsById, "card-list", setStatus, (databaseId, card) => {
            translatedRows += applyCardListCardTranslation(databaseId, card);
          })
        );
      })
    );
  }

  async function translateForbiddenLimitedPage() {
    translateLimitBadges();
    const translatedLabels = translateForbiddenLimitedStaticLabels();
    const cardIds = getCardListIds();
    if (cardIds.length === 0) {
      setStatus("No Limit Regulation cards found to translate.", translatedLabels === 0);
      return;
    }

    setStatus(`Loading English data for Limit Regulation... 0/${cardIds.length}`);
    let translatedRows = 0;
    const cardsById = await getCardDataMap(cardIds, (completed, total, result, phase) => {
      const waitMessage = getRetryWaitMessage(result, "card-list");
      setStatus(waitMessage || (phase === "final-retry"
        ? `Retrying missing Limit Regulation cards... ${getLoadedCount(result, completed)}/${total}`
        : `Loading English data for Limit Regulation... ${completed}/${total}`), false, null, result && result.retryNow);
    }, (databaseId, card) => {
      translatedRows += applyCardListCardTranslation(databaseId, card);
    });
    setStatus(
      buildCardBatchStatus(`Translated ${translatedRows} Limit Regulation rows (${cardsById.size}/${cardIds.length} unique cards).`, cardsById),
      hasFailedLookups(cardsById),
      null,
      buildRetryAction(cardsById, "Limit Regulation", setStatus, (databaseId, card) => {
        translatedRows += applyCardListCardTranslation(databaseId, card);
      }, (retryCardsById) => {
        setStatus(
          buildCardBatchStatus(`Translated ${translatedRows} Limit Regulation rows (${cardsById.size + retryCardsById.size}/${cardIds.length} unique cards).`, retryCardsById),
          hasFailedLookups(retryCardsById),
          null,
          buildRetryAction(retryCardsById, "Limit Regulation", setStatus, (databaseId, card) => {
            translatedRows += applyCardListCardTranslation(databaseId, card);
          })
        );
      })
    );
  }

  async function translateDeckSearchPage() {
    const translated = translateDeckSearchStaticLabels();
    if (await isCategorySortingEnabled()) {
      sortDeckSearchCategories();
    }
    setStatus(`Translated ${translated} deck search labels.`);
  }

  function translateCardSearchPage() {
    const translated = translateCardSearchStaticLabels();
    setStatus(`Translated ${translated} card search labels.`);
  }

  async function getDeckCardData(cardIds, onCard) {
    return getCardDataMap(cardIds, (completed, total, result, phase) => {
      const waitMessage = getRetryWaitMessage(result, "deck");
      setStatus(waitMessage || (phase === "final-retry"
        ? `Retrying missing deck cards... ${getLoadedCount(result, completed)}/${total}`
        : `Loading English data for deck... ${completed}/${total}`), false, null, result && result.retryNow);
    }, onCard);
  }

  async function getCardDataMap(cardIds, onProgress, onCard) {
    const cardsById = new Map();
    let completed = 0;
    const stats = {
      total: cardIds.length,
      failed: 0,
      missing: 0,
      errors: 0,
      failedIds: [],
    };
    const failedRecords = [];

    async function runQueue(ids, parallelism, phase, retryOptions) {
      const queue = ids.slice();
      const workerCount = Math.min(parallelism, queue.length);
      if (workerCount === 0) {
        return [];
      }

      const failures = [];
      const pendingRetries = [];
      const settings = retryOptions || {};
      const retryDelays = settings.retryDelays || CARD_LOOKUP_RETRY_DELAYS;
      const retryCount = Number.isFinite(settings.retryCount) ? settings.retryCount : CARD_LOOKUP_RETRY_COUNT;
      const retryNullResults = settings.retryNullResults !== false;
      const requestTimeoutMs = settings.requestTimeoutMs || CARD_LOOKUP_BATCH_TIMEOUT_MS;
      const lookupTimeoutMs = settings.lookupTimeoutMs || (requestTimeoutMs * 2) + CARD_LOOKUP_TIMEOUT_BUFFER_MS;
      const backgroundRetries = settings.backgroundRetries === true;

      function reportProgress(result, progressPhase) {
        if (!onProgress) {
          return;
        }

        if (result) {
          result.loaded = cardsById.size;
          result.total = cardIds.length;
        }
        onProgress(completed, cardIds.length, result, progressPhase);
      }

      function scheduleRetry(databaseId, attempt, lastError, lastCard) {
        const waitingMs = getRetryDelay(retryDelays, attempt);
        const retryTask = (async () => {
          await waitForRetryDelay(waitingMs, onProgress
            ? (retryNow) => {
              reportProgress({
                waitingMs,
                databaseId,
                attempt: attempt + 1,
                retryNow,
                failed: true,
                error: lastError,
                card: lastCard,
              }, `${phase}-wait`);
            }
            : null);
          await lookupWithScheduledRetry(databaseId, attempt + 1, lastError, lastCard);
        })();
        pendingRetries.push(retryTask);
      }

      function scheduleBackgroundFailedLookup(databaseId, backgroundAttempt) {
        if (!onCard || cardsById.has(databaseId) || backgroundAttempt >= CARD_LOOKUP_BACKGROUND_RETRY_DELAYS.length) {
          return;
        }

        const waitingMs = getRetryDelay(CARD_LOOKUP_BACKGROUND_RETRY_DELAYS, backgroundAttempt);
        setTimeout(async () => {
          if (cardsById.has(databaseId)) {
            return;
          }

          try {
            const card = await getCardData(databaseId, { timeoutMs: CARD_LOOKUP_FINAL_TIMEOUT_MS });
            if (card && !cardsById.has(databaseId)) {
              cardsById.set(databaseId, card);
              onCard(databaseId, card);
              return;
            }
          } catch (error) {
            console.warn("[RushDB Yugipedia English] Background card lookup failed", databaseId, error);
          }

          scheduleBackgroundFailedLookup(databaseId, backgroundAttempt + 1);
        }, waitingMs);
      }

      async function lookupWithScheduledRetry(databaseId, attempt, lastError, lastCard) {
        let result = null;
        let caughtError = null;
        let card = null;

        try {
          card = await withTimeout(
            getCardData(databaseId, { timeoutMs: requestTimeoutMs }),
            lookupTimeoutMs,
            `Lookup timed out for ${databaseId}`
          );
          result = { card, attempts: attempt + 1, failed: !card };
          lastCard = card;
        } catch (error) {
          caughtError = error;
          lastError = error;
        }

        if (phase === "initial" && attempt === 0) {
          completed += 1;
        }

        if (card) {
          if (!cardsById.has(databaseId)) {
            cardsById.set(databaseId, card);
            if (onCard) {
              onCard(databaseId, card);
            }
          }
          reportProgress(result, phase);
          return;
        }

        if ((card || !retryNullResults) || attempt >= retryCount) {
          if (caughtError) {
            failures.push({ databaseId, error: caughtError, kind: "error", reason: getLookupFailureReason(caughtError) });
            console.warn("[RushDB Yugipedia English] Card lookup failed", databaseId, caughtError);
          } else {
            failures.push({ databaseId, result: result || { card: lastCard, attempts: attempt + 1, failed: true }, kind: "missing", reason: "missing" });
          }
          reportProgress(result || { card: lastCard, attempts: attempt + 1, failed: true, error: caughtError }, phase);
          return;
        }

        reportProgress(result || { card: lastCard, attempts: attempt + 1, failed: true, error: caughtError }, phase);
        scheduleRetry(databaseId, attempt, lastError, lastCard);
      }

      async function worker() {
        while (queue.length > 0) {
          const databaseId = queue.shift();
          await lookupWithScheduledRetry(databaseId, 0, null, null);
        }
      }

      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      while (pendingRetries.length > 0) {
        await Promise.all(pendingRetries.splice(0));
      }
      if (backgroundRetries) {
        failures
          .map((record) => record.databaseId)
          .filter((databaseId) => !cardsById.has(databaseId))
          .forEach((databaseId) => scheduleBackgroundFailedLookup(databaseId, 0));
      }
      return failures;
    }

    failedRecords.push(...await runQueue(cardIds, CARD_LOOKUP_PARALLELISM, "initial", {
      retryDelays: CARD_LOOKUP_RETRY_DELAYS,
      retryNullResults: true,
      requestTimeoutMs: CARD_LOOKUP_BATCH_TIMEOUT_MS,
    }));

    const retryIds = failedRecords
      .map((record) => record.databaseId)
      .filter((databaseId) => !cardsById.has(databaseId));

    if (retryIds.length > 0) {
      const finalFailures = await runQueue(retryIds, CARD_LOOKUP_FINAL_PARALLELISM, "final-retry", {
        retryDelays: CARD_LOOKUP_FINAL_RETRY_DELAYS,
        retryCount: 2,
        retryNullResults: true,
        requestTimeoutMs: CARD_LOOKUP_FINAL_TIMEOUT_MS,
        backgroundRetries: true,
      });
      stats.failed = finalFailures.length;
      stats.missing = finalFailures.filter((record) => record.kind === "missing").length;
      stats.errors = finalFailures.filter((record) => record.kind === "error").length;
      stats.failedIds = finalFailures.map((record) => record.databaseId);
    }

    cardsById.lookupStats = stats;
    return cardsById;
  }

  function buildCardBatchStatus(baseMessage, cardsById) {
    const stats = cardsById && cardsById.lookupStats;
    if (!stats || stats.failed < 1) {
      return baseMessage;
    }

    return `${baseMessage} ${stats.failed} ${stats.failed === 1 ? "card" : "cards"} did not load from the hosted database or Yugipedia.`;
  }

  function hasFailedLookups(cardsById) {
    const stats = cardsById && cardsById.lookupStats;
    return Boolean(stats && stats.failed > 0 && stats.failedIds && stats.failedIds.length > 0);
  }

  function buildRetryAction(cardsById, label, setProgress, onCard, onDone) {
    const stats = cardsById && cardsById.lookupStats;
    const failedIds = stats && stats.failedIds ? stats.failedIds.slice() : [];
    if (failedIds.length === 0) {
      return null;
    }

    return async () => {
      setProgress(`Retrying ${failedIds.length} missing ${label} cards...`);
      const retryCardsById = await getCardDataMap(failedIds, (completed, total, result, phase) => {
        const waitMessage = getRetryWaitMessage(result, label);
        setProgress(waitMessage || (phase === "final-retry"
          ? `Retrying missing ${label} cards... ${getLoadedCount(result, completed)}/${total}`
          : `Loading retry data for ${label} cards... ${completed}/${total}`), false, null, result && result.retryNow);
      }, onCard);

      if (onDone) {
        onDone(retryCardsById);
      } else {
        setProgress(buildCardBatchStatus(`Retry loaded ${retryCardsById.size}/${failedIds.length} missing ${label} cards.`, retryCardsById));
      }
    };
  }

  async function getCardDataWithRetry(databaseId, options) {
    const settings = options || {};
    const retryDelays = settings.retryDelays || CARD_LOOKUP_RETRY_DELAYS;
    const retryCount = Number.isFinite(settings.retryCount) ? settings.retryCount : CARD_LOOKUP_RETRY_COUNT;
    const retryNullResults = settings.retryNullResults !== false;
    let lastError = null;
    let lastCard = null;

    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
      try {
        const card = await getCardData(databaseId, { timeoutMs: settings.requestTimeoutMs || CARD_LOOKUP_DETAIL_TIMEOUT_MS });
        if (card || !retryNullResults || attempt >= retryCount) {
          return { card, attempts: attempt + 1, failed: !card };
        }

        lastCard = card;
      } catch (error) {
        lastError = error;
      }

      if (attempt < retryCount) {
        const waitingMs = getRetryDelay(retryDelays, attempt);
        await waitForRetryDelay(waitingMs, settings.onRetryWait
          ? (retryNow) => settings.onRetryWait({
            waitingMs,
            databaseId,
            attempt: attempt + 1,
            retryNow,
          })
          : null);
      }
    }

    if (lastError) {
      throw lastError;
    }

    return { card: lastCard, attempts: retryCount + 1, failed: true };
  }

  function getRetryDelay(delays, attempt) {
    const base = delays[Math.min(attempt, delays.length - 1)] || 1000;
    const jitter = Math.floor(Math.random() * Math.max(250, base * 0.25));
    return base + jitter;
  }

  function withTimeout(promise, ms, message) {
    if (!Number.isFinite(ms) || ms <= 0) {
      return promise;
    }

    let timeoutId = null;
    const timeout = new Promise((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message || `Operation timed out after ${ms}ms`)), ms);
    });

    return Promise.race([promise, timeout]).finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
  }

  function getLookupFailureReason(error) {
    const message = error && error.message ? error.message : "";
    if (/timed out|abort/i.test(message)) {
      return "timeout";
    }
    if (/HTTP\s+429/.test(message)) {
      return "rate_limited";
    }
    if (/HTTP\s+5\d\d/.test(message)) {
      return "server_error";
    }
    if (/HTTP\s+4\d\d/.test(message)) {
      return "client_error";
    }
    if (/api_error|Request failed/i.test(message)) {
      return "network_or_api_error";
    }
    return "error";
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitForRetryDelay(ms, onWait) {
    if (!onWait) {
      return delay(ms);
    }

    return new Promise((resolve) => {
      let resolved = false;
      let timeoutId = null;
      const finish = () => {
        if (resolved) {
          return;
        }

        resolved = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        resolve();
      };
      finish.retryLabel = "Retry now";
      timeoutId = setTimeout(finish, ms);
      onWait(finish);
    });
  }

  function getRetryWaitMessage(result, label) {
    if (!result || !result.retryNow || !result.waitingMs) {
      return "";
    }

    const seconds = Math.max(1, Math.ceil(result.waitingMs / 1000));
    const progress = Number.isFinite(result.loaded) && Number.isFinite(result.total)
      ? `(${result.loaded}/${result.total}) `
      : "";
    return `${progress}Waiting ${seconds}s before retrying one missing ${getUserFacingLookupLabel(label)}...`;
  }

  function getLoadedCount(result, fallback) {
    return result && Number.isFinite(result.loaded) ? result.loaded : fallback;
  }

  function getUserFacingLookupLabel(label) {
    if (label === "card-list" || label === "related-card") {
      return "card";
    }

    if (label === "deck") {
      return "deck card";
    }

    return "card";
  }

  async function getCardData(databaseId, options) {
    const requestOptions = options || {};
    const cached = readCache(databaseId);
    if (cached) {
      return cached;
    }

    const lookupKey = String(databaseId);
    const inFlight = inFlightCardLookups.get(lookupKey);
    if (inFlight) {
      return inFlight;
    }

    const lookup = getUncachedCardData(lookupKey, requestOptions)
      .finally(() => inFlightCardLookups.delete(lookupKey));
    inFlightCardLookups.set(lookupKey, lookup);
    return lookup;
  }

  async function getUncachedCardData(databaseId, requestOptions) {
    const hostedCard = await getHostedDatabaseCard(databaseId, requestOptions);
    if (hostedCard) {
      writeCache(databaseId, hostedCard);
      return hostedCard;
    }

    const titles = await searchByDatabaseId(databaseId, requestOptions);
    const cards = await fetchCardPages(titles, requestOptions);
    for (const card of cards) {
      if (card && normalizeField(card.fields.database_id) === databaseId) {
        writeCache(databaseId, card);
        return card;
      }
    }

    return null;
  }

  async function getHostedDatabaseCard(databaseId, options) {
    let database = null;
    try {
      database = await loadHostedDatabase(options);
    } catch (error) {
      console.warn("[RushDB Yugipedia English] Hosted database lookup failed; falling back to Yugipedia", error);
      return null;
    }

    const cards = database && database.cardsByDatabaseId;
    const rawCard = cards && cards[String(databaseId)];
    return rawCard ? normalizeHostedDatabaseCard(databaseId, rawCard) : null;
  }

  async function loadHostedDatabase(options) {
    if (!hostedDatabasePromise) {
      const timeoutMs = options && options.timeoutMs
        ? Math.max(options.timeoutMs, HOSTED_DATABASE_TIMEOUT_MS)
        : HOSTED_DATABASE_TIMEOUT_MS;
      hostedDatabasePromise = requestText(HOSTED_DATABASE_URL, { timeoutMs })
        .then((text) => JSON.parse(text))
        .catch((error) => {
          hostedDatabasePromise = null;
          throw error;
        });
    }

    return hostedDatabasePromise;
  }

  function normalizeHostedDatabaseCard(databaseId, rawCard) {
    const fields = rawCard && rawCard.fields && typeof rawCard.fields === "object"
      ? rawCard.fields
      : {};
    const display = rawCard && rawCard.display && typeof rawCard.display === "object"
      ? rawCard.display
      : null;
    const title = cleanWikiText((display && display.title) || rawCard.title || fields.name || fields.en_name || "");

    return {
      title,
      url: rawCard.url || "",
      pageid: rawCard.pageid || 0,
      pageTitle: rawCard.pageTitle || rawCard.title || "",
      fields,
      display,
      officialDatabaseId: rawCard.officialDatabaseId || normalizeField(fields.database_id || databaseId),
      sourceStatus: rawCard.sourceStatus || "official",
      source: "hosted-database",
    };
  }

  async function searchByDatabaseId(databaseId, options) {
    const data = await apiRequest({
      action: "query",
      format: "json",
      list: "search",
      srwhat: "text",
      srlimit: "5",
      srsearch: `"${databaseId}" "database_id"`,
    }, options);

    const results = data && data.query && Array.isArray(data.query.search)
      ? data.query.search
      : [];

    return results
      .filter((result) => result.ns === 0 && result.title)
      .map((result) => result.title);
  }

  async function fetchCardPages(titles, options) {
    const uniqueTitles = Array.from(new Set((titles || []).filter(Boolean)));
    if (uniqueTitles.length === 0) {
      return [];
    }

    const data = await apiRequest({
      action: "query",
      format: "json",
      prop: "revisions",
      rvprop: "content",
      titles: uniqueTitles.join("|"),
    }, options);

    const pages = data && data.query && data.query.pages
      ? Object.values(data.query.pages)
      : [];

    return pages
      .map((page) => parseFetchedCardPage(page))
      .filter(Boolean);
  }

  async function fetchCardPage(title, options) {
    const cards = await fetchCardPages([title], options);
    return cards[0] || null;
  }

  function parseFetchedCardPage(page) {
    const revision = page && page.revisions && page.revisions[0];
    const wikitext = getRevisionText(revision);

    if (!page || !wikitext) {
      return null;
    }

    const fields = parseCardTable(wikitext);
    const pageTitle = page.title || "";

    return {
      title: pageTitle,
      url: `https://yugipedia.com/wiki/${encodeURIComponent(pageTitle.replace(/ /g, "_"))}`,
      fields,
    };
  }

  function getRevisionText(revision) {
    if (!revision) {
      return "";
    }

    return revision["*"]
      || (revision.slots && revision.slots.main && revision.slots.main["*"])
      || revision.content
      || "";
  }

  function parseCardTable(wikitext) {
    const fields = {};
    const lines = wikitext.split(/\r?\n/);
    let currentKey = null;

    for (const line of lines) {
      const match = line.match(/^\|\s*([^=]+?)\s*=\s*(.*)$/);
      if (match) {
        currentKey = match[1].trim();
        fields[currentKey] = match[2].trim();
      } else if (currentKey && !line.startsWith("}}")) {
        fields[currentKey] += `\n${line.trim()}`;
      } else {
        currentKey = null;
      }
    }

    return fields;
  }

  async function apiRequest(query, options) {
    const url = `${API}?${new URLSearchParams(query).toString()}`;
    const responseText = await requestText(url, options);
    const data = JSON.parse(responseText);
    if (data && data.error) {
      const code = data.error.code || "api_error";
      const info = data.error.info || "Yugipedia API error";
      throw new Error(`${code}: ${info}`);
    }
    return data;
  }

  function requestText(url, options) {
    const timeoutMs = options && options.timeoutMs ? options.timeoutMs : CARD_LOOKUP_DETAIL_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const gm4Request = typeof GM !== "undefined" && GM.xmlHttpRequest;
      const gm3Request = typeof GM_xmlhttpRequest !== "undefined" && GM_xmlhttpRequest;
      const requester = gm4Request || gm3Request;

      if (requester) {
        requester({
          method: "GET",
          url,
          timeout: timeoutMs,
          headers: {
            Accept: "application/json",
          },
          onload: (response) => {
            if (response.status >= 200 && response.status < 300) {
              resolve(response.responseText);
            } else {
              reject(new Error(`HTTP ${response.status} for ${url}`));
            }
          },
          onerror: () => reject(new Error(`Request failed for ${url}`)),
          ontimeout: () => reject(new Error(`Request timed out after ${timeoutMs}ms for ${url}`)),
        });
        return;
      }

      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      fetch(url, { credentials: "omit", signal: controller ? controller.signal : undefined })
        .then((response) => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} for ${url}`);
          }
          return response.text();
        })
        .finally(() => {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
        })
        .then(resolve, reject);
    });
  }

  function requestArrayBuffer(url, options) {
    const timeoutMs = options && options.timeoutMs ? options.timeoutMs : CARD_LOOKUP_DETAIL_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const gm4Request = typeof GM !== "undefined" && GM.xmlHttpRequest;
      const gm3Request = typeof GM_xmlhttpRequest !== "undefined" && GM_xmlhttpRequest;
      const requester = gm4Request || gm3Request;

      if (requester) {
        requester({
          method: "GET",
          url,
          timeout: timeoutMs,
          responseType: "arraybuffer",
          onload: (response) => {
            if (response.status >= 200 && response.status < 300) {
              resolve(response.response);
            } else {
              reject(new Error(`HTTP ${response.status} for ${url}`));
            }
          },
          onerror: () => reject(new Error(`Request failed for ${url}`)),
          ontimeout: () => reject(new Error(`Request timed out after ${timeoutMs}ms for ${url}`)),
        });
        return;
      }

      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      fetch(url, { credentials: "omit", signal: controller ? controller.signal : undefined })
        .then((response) => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} for ${url}`);
          }
          return response.arrayBuffer();
        })
        .finally(() => {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
        })
        .then(resolve, reject);
    });
  }

  async function readZipTextFile(arrayBuffer, fileName, optional) {
    const bytes = new Uint8Array(arrayBuffer);
    const entry = findZipEntry(bytes, fileName);
    if (!entry) {
      if (optional) {
        return "";
      }
      throw new Error(`XLSX file is missing ${fileName}.`);
    }

    const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    let fileBytes = null;
    if (entry.compressionMethod === 0) {
      fileBytes = compressed;
    } else if (entry.compressionMethod === 8) {
      fileBytes = await inflateRawBytes(compressed);
    } else {
      throw new Error(`Unsupported XLSX ZIP compression method ${entry.compressionMethod}.`);
    }

    return new TextDecoder("utf-8").decode(fileBytes);
  }

  function findZipEntry(bytes, fileName) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocdOffset = findZipEndOfCentralDirectory(bytes);
    if (eocdOffset < 0) {
      throw new Error("Could not read XLSX ZIP directory.");
    }

    const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
    const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
    let offset = centralDirectoryOffset;
    const endOffset = centralDirectoryOffset + centralDirectorySize;

    while (offset < endOffset && view.getUint32(offset, true) === 0x02014b50) {
      const compressionMethod = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const fileNameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localHeaderOffset = view.getUint32(offset + 42, true);
      const name = decodeZipAscii(bytes.subarray(offset + 46, offset + 46 + fileNameLength));

      if (name === fileName) {
        const localFileNameLength = view.getUint16(localHeaderOffset + 26, true);
        const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
        return {
          compressionMethod,
          compressedSize,
          dataOffset: localHeaderOffset + 30 + localFileNameLength + localExtraLength,
        };
      }

      offset += 46 + fileNameLength + extraLength + commentLength;
    }

    return null;
  }

  function findZipEndOfCentralDirectory(bytes) {
    for (let offset = bytes.length - 22; offset >= 0 && offset >= bytes.length - 0xffff - 22; offset -= 1) {
      if (bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b && bytes[offset + 2] === 0x05 && bytes[offset + 3] === 0x06) {
        return offset;
      }
    }
    return -1;
  }

  function decodeZipAscii(bytes) {
    let text = "";
    bytes.forEach((byte) => {
      text += String.fromCharCode(byte);
    });
    return text;
  }

  async function inflateRawBytes(bytes) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("This browser cannot decompress the online EDOPro XLSX file.");
    }

    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function applyEnglishData(card) {
    const display = getCardDisplayData(card);

    translateLimitBadges();
    translateCardStaticLabels();
    translateReleaseSeries(card);
    replaceCardName(display.title);
    replaceMonsterSummary(display);
    replaceSpellTrapSummary(display);
    replaceCardText(display);

    document.title = document.title.replace(/^.*?\s*\|/, `${display.title} |`);
  }

  function getCardDisplayData(card) {
    if (card && card.display) {
      const display = card.display;
      const cardType = cleanWikiText(display.cardType || "");
      const property = cleanWikiText(display.property || "");
      const types = cleanWikiText(display.types || "");
      const kindText = cleanWikiText(display.kindText || "") || getKindText({ cardType, property, types });
      return {
        title: cleanWikiText(display.title || card.title),
        cardType,
        property,
        attribute: cleanWikiText(display.attribute || ""),
        level: cleanWikiText(display.level || ""),
        types,
        requirement: cleanWikiText(display.requirement || ""),
        effect: cleanWikiText(display.effect || ""),
        preface: Array.isArray(display.preface) ? display.preface.map(cleanWikiText).filter(Boolean) : [],
        kindText,
      };
    }

    const fields = card.fields || {};
    const title = cleanWikiText(card.title);
    const cardType = cleanWikiText(fields.card_type || "");
    const property = cleanWikiText(fields.property || "");
    const attribute = cleanWikiText(fields.attribute || "");
    const level = cleanWikiText(fields.level || "");
    const types = cleanWikiText(fields.types || "");
    const requirement = cleanWikiText(fields.requirement || "");
    const effect = cleanWikiText(fields.text || fields.lore || fields.description || "");
    const preface = [
      fields.summon_condition,
      fields.summoning_condition,
      fields.condition,
      fields.materials,
      fields.fusion_materials,
    ].map(cleanWikiText).filter(Boolean);

    return {
      title,
      cardType,
      property,
      attribute,
      level,
      types,
      requirement,
      effect,
      preface,
      kindText: getKindText({ cardType, property, types }),
    };
  }

  function getKindText({ cardType, property, types }) {
    if (types) {
      return types.split("/").map((part) => part.trim()).filter(Boolean).join(" / ");
    }

    if (cardType) {
      return property ? `${property} ${cardType}` : cardType;
    }

    return "";
  }

  function getDeckCardIds() {
    const ids = new Set();
    document.querySelectorAll("#deck_text input.link_value, #deck_detailtext input.link_value, #deck_image a[href*='card_search.action']").forEach((node) => {
      const cidFromValue = extractCid(node.value || node.getAttribute("href") || "");
      if (cidFromValue) {
        ids.add(cidFromValue);
      }
    });

    return Array.from(ids);
  }

  function getDeckYdkeEntries() {
    const entries = [];
    const sections = [
      { part: "main", selector: "#monster_list, #spell_list, #trap_list" },
      { part: "extra", selector: "#extra_list" },
      { part: "side", selector: "#side_list" },
    ];

    sections.forEach((section) => {
      document.querySelectorAll(section.selector).forEach((table) => {
        table.querySelectorAll("tr").forEach((row) => {
          const input = row.querySelector("input.link_value");
          if (!input) {
            return;
          }

          const nameNode = getDeckTextNameNode(row);
          const japaneseName = cleanText(nameNode && nameNode.textContent) || cleanText(row.title);
          const databaseId = extractCid(input.value || "");
          const quantity = getDeckTextRowQuantity(row);
          if (!japaneseName || !databaseId || quantity < 1) {
            return;
          }

          entries.push({
            part: section.part,
            japaneseName,
            databaseId,
            quantity,
          });
        });
      });
    });

    if (entries.length > 0) {
      return entries;
    }

    return getDeckYdkeEntriesFromDetailText();
  }

  function getDeckYdkeEntriesFromDetailText() {
    const entries = [];
    const sections = [
      { part: "main", selector: "#detailtext_main" },
      { part: "extra", selector: "#detailtext_ext" },
      { part: "side", selector: "#detailtext_side" },
    ];

    sections.forEach((section) => {
      const root = document.querySelector(section.selector);
      if (!root) {
        return;
      }

      root.querySelectorAll(".t_row").forEach((row) => {
        const input = row.querySelector("input.link_value");
        const nameNode = row.querySelector(".box_card_name .card_name");
        const japaneseName = cleanText(nameNode && nameNode.textContent);
        const databaseId = extractCid(input && input.value);
        const quantity = getDeckDetailRowQuantity(row);
        if (!japaneseName || !databaseId || quantity < 1) {
          return;
        }

        entries.push({
          part: section.part,
          japaneseName,
          databaseId,
          quantity,
        });
      });
    });

    return entries;
  }

  function getDeckTextRowQuantity(row) {
    const value = cleanText(row.querySelector("td.num span") && row.querySelector("td.num span").textContent)
      || cleanText(row.querySelector("td.num") && row.querySelector("td.num").textContent);
    return parseDeckQuantity(value);
  }

  function getDeckDetailRowQuantity(row) {
    const directQuantity = Array.from(row.children).find((child) => child.classList && child.classList.contains("cards_num_set"));
    const value = cleanText(directQuantity && directQuantity.textContent);
    return parseDeckQuantity(value);
  }

  function parseDeckQuantity(value) {
    const match = String(value || "").match(/\d+/);
    const quantity = match ? Number(match[0]) : 1;
    return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
  }

  async function getDeckYdkeCopyState(entries, cardsById) {
    if (!entries || entries.length === 0) {
      return null;
    }

    try {
      return await buildDeckYdkeCopyState(entries, cardsById);
    } catch (error) {
      console.warn("[RushDB Yugipedia English] Could not load EDOPro card IDs", error);
      return {
        deck: { main: [], extra: [], side: [] },
        missing: [],
        ambiguous: [],
        totalCards: entries.reduce((total, entry) => total + entry.quantity, 0),
        copiedCards: 0,
        loadError: error,
      };
    }
  }

  async function buildDeckYdkeCopyState(entries, cardsById) {
    const deck = { main: [], extra: [], side: [] };
    const missing = [];
    const ambiguous = [];
    let totalCards = 0;
    const cardsByJapaneseName = await getEdoproRushCardsByJapaneseName();

    entries.forEach((entry) => {
      totalCards += entry.quantity;
      const resolution = resolveEdoproRushCardId(entry, cardsById, cardsByJapaneseName);
      if (!resolution.id) {
        missing.push(entry);
        return;
      }

      if (resolution.ambiguous) {
        ambiguous.push(entry);
      }

      for (let index = 0; index < entry.quantity; index += 1) {
        deck[entry.part].push(resolution.id);
      }
    });

    return {
      deck,
      missing,
      ambiguous,
      totalCards,
      copiedCards: deck.main.length + deck.extra.length + deck.side.length,
    };
  }

  function resolveEdoproRushCardId(entry, cardsById, cardsByJapaneseName) {
    const candidates = cardsByJapaneseName.get(normalizeEdoproCardName(entry.japaneseName)) || [];
    if (candidates.length === 0) {
      return { id: 0, ambiguous: false };
    }

    if (candidates.length === 1) {
      return { id: candidates[0].id, ambiguous: false };
    }

    const card = cardsById && cardsById.get(entry.databaseId);
    const title = card ? normalizeEdoproEnglishName(getCardDisplayData(card).title) : "";
    const exactEnglishMatches = title
      ? candidates.filter((candidate) => normalizeEdoproEnglishName(candidate.englishName) === title)
      : [];

    if (exactEnglishMatches.length === 1) {
      return { id: exactEnglishMatches[0].id, ambiguous: false };
    }

    const looseEnglishMatches = title
      ? candidates.filter((candidate) => {
        const candidateName = normalizeEdoproEnglishName(candidate.englishName).replace(/\(rush\)$/i, "").trim();
        return candidateName && (candidateName === title || candidateName.replace(/[#.'-]/g, "") === title.replace(/[#.'-]/g, ""));
      })
      : [];

    if (looseEnglishMatches.length === 1) {
      return { id: looseEnglishMatches[0].id, ambiguous: false };
    }

    return { id: candidates[0].id, ambiguous: true };
  }

  async function getEdoproRushCardsByJapaneseName() {
    if (!edoproRushCardsPromise) {
      edoproRushCardsPromise = loadEdoproRushCardsByJapaneseName();
    }
    return edoproRushCardsPromise;
  }

  async function loadEdoproRushCardsByJapaneseName() {
    const rows = await fetchEdoproRushCardIdRows();
    const cardsByJapaneseName = new Map();
    rows.forEach((row) => {
      const id = Number(row[0]);
      const englishName = String(row[1] || "");
      const japaneseName = normalizeEdoproCardName(row[2]);
      if (!id || !japaneseName) {
        return;
      }

      const candidates = cardsByJapaneseName.get(japaneseName) || [];
      candidates.push({ id, englishName });
      cardsByJapaneseName.set(japaneseName, candidates);
    });

    return cardsByJapaneseName;
  }

  async function fetchEdoproRushCardIdRows() {
    const workbook = await requestArrayBuffer(EDOPRO_RUSH_CARD_IDS_XLSX_URL, { timeoutMs: HOSTED_DATABASE_TIMEOUT_MS });
    const sharedStringsXml = await readZipTextFile(workbook, "xl/sharedStrings.xml", true);
    const sheetXml = await readZipTextFile(workbook, "xl/worksheets/sheet1.xml");
    const sharedStrings = parseXlsxSharedStrings(sharedStringsXml);
    return parseEdoproRushCardIdSheet(sheetXml, sharedStrings);
  }

  function parseXlsxSharedStrings(xmlText) {
    if (!xmlText) {
      return [];
    }

    const documentXml = new DOMParser().parseFromString(xmlText, "application/xml");
    return Array.from(documentXml.getElementsByTagName("si")).map((item) => {
      return Array.from(item.getElementsByTagName("t")).map((node) => node.textContent || "").join("");
    });
  }

  function parseEdoproRushCardIdSheet(xmlText, sharedStrings) {
    const documentXml = new DOMParser().parseFromString(xmlText, "application/xml");
    const rows = [];
    Array.from(documentXml.getElementsByTagName("row")).forEach((row, rowIndex) => {
      if (rowIndex === 0) {
        return;
      }

      const values = ["", "", ""];
      Array.from(row.getElementsByTagName("c")).forEach((cell) => {
        const reference = cell.getAttribute("r") || "";
        const column = reference.match(/^[A-Z]+/);
        const columnIndex = column ? xlsxColumnIndex(column[0]) : -1;
        if (columnIndex < 0 || columnIndex > 2) {
          return;
        }

        values[columnIndex] = getXlsxCellValue(cell, sharedStrings);
      });

      if (values[0] && values[2]) {
        rows.push(values);
      }
    });
    return rows;
  }

  function getXlsxCellValue(cell, sharedStrings) {
    const valueNode = cell.getElementsByTagName("v")[0];
    const inlineStringNode = cell.getElementsByTagName("t")[0];
    const rawValue = valueNode ? valueNode.textContent || "" : "";
    if (cell.getAttribute("t") === "s") {
      return sharedStrings[Number(rawValue)] || "";
    }
    if (cell.getAttribute("t") === "inlineStr") {
      return inlineStringNode ? inlineStringNode.textContent || "" : "";
    }
    return rawValue;
  }

  function xlsxColumnIndex(column) {
    let index = 0;
    for (let offset = 0; offset < column.length; offset += 1) {
      index = index * 26 + column.charCodeAt(offset) - 64;
    }
    return index - 1;
  }

  function normalizeEdoproCardName(value) {
    return cleanText(value).normalize ? cleanText(value).normalize("NFKC") : cleanText(value);
  }

  function normalizeEdoproEnglishName(value) {
    return normalizeEdoproCardName(value)
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function makeYdke(deck) {
    return `ydke://${idsToYdkePart(deck.main || [])}!${idsToYdkePart(deck.extra || [])}!${idsToYdkePart(deck.side || [])}!`;
  }

  function makeYdk(deck, creator) {
    const lines = [];
    lines.push(`#created by ${creator || "https://github.com/TrainStream/Yu-Gi-Oh-Rush-Database-English/"}`);
    lines.push("#main");
    (deck.main || []).forEach((id) => lines.push(String(id)));
    lines.push("#extra");
    (deck.extra || []).forEach((id) => lines.push(String(id)));
    lines.push("!side");
    (deck.side || []).forEach((id) => lines.push(String(id)));
    return `${lines.join("\n")}\n`;
  }

  function downloadTextFile(text, filename) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function getDeckExportFilename(extension) {
    const title = getDeckExportTitle();
    const slug = title
      ? title.normalize("NFKC").replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "_").trim()
      : "rush_deck";
    return `${slug || "rush_deck"}.${extension}`;
  }

  function getDeckExportTitle() {
    const candidates = [
      document.querySelector("#broad_title h1 strong"),
      document.querySelector("#broad_title h1"),
      document.querySelector("#title_msg h1"),
      document.querySelector("#title_msg"),
    ];

    for (const candidate of candidates) {
      const title = cleanText(candidate && candidate.textContent);
      if (title) {
        return title;
      }
    }

    return cleanText(document.title).replace(/\|.*$/, "").trim();
  }

  function idsToYdkePart(ids) {
    const bytes = new Uint8Array(ids.length * 4);
    const view = new DataView(bytes.buffer);
    ids.forEach((id, index) => {
      view.setUint32(index * 4, Number(id), true);
    });

    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }

    return btoa(binary);
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "readonly");
    textarea.style.cssText = [
      "position: fixed",
      "top: -9999px",
      "left: -9999px",
      "opacity: 0",
    ].join(";");
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  function getCardListIds() {
    const ids = new Set();
    const scope = getCardListScopeSelector();
    document.querySelectorAll(`${scope} input.link_value, ${scope} a[href*='card_search.action']`).forEach((node) => {
      const cidFromValue = extractCid(node.value || node.getAttribute("href") || "");
      if (cidFromValue) {
        ids.add(cidFromValue);
      }
    });

    return Array.from(ids);
  }

  function getCardListScopeSelector() {
    return isForbiddenLimitedPage ? "#article_body" : "#card_list";
  }

  function applyDeckTranslations(cardsById) {
    let translatedRows = 0;

    cardsById.forEach((card, databaseId) => {
      translatedRows += applyDeckCardTranslation(databaseId, card);
    });

    return translatedRows;
  }

  function applyDeckCardTranslation(databaseId, card) {
    let translatedRows = 0;

    document.querySelectorAll("#deck_text input.link_value").forEach((input) => {
      if (extractCid(input.value) !== databaseId) {
        return;
      }

      const row = input.closest("tr");
      if (!row) {
        return;
      }

      const display = getCardDisplayData(card);
      if (replaceDeckTextRow(row, display)) {
        translatedRows += 1;
      }
    });

    document.querySelectorAll("#deck_detailtext input.link_value").forEach((input) => {
      if (extractCid(input.value) !== databaseId) {
        return;
      }

      const row = input.closest(".t_row");
      if (!row) {
        return;
      }

      const display = getCardDisplayData(card);
      if (replaceDeckDetailRow(row, display)) {
        translatedRows += 1;
      }
    });

    document.querySelectorAll("#deck_image a[href*='card_search.action']").forEach((link) => {
      if (extractCid(link.getAttribute("href") || "") !== databaseId) {
        return;
      }

      const display = getCardDisplayData(card);
      rememberOriginal(link, "title", link.title);
      link.title = display.title;
      link.querySelectorAll("img").forEach((image) => {
        rememberOriginal(image, "alt", image.alt);
        rememberOriginal(image, "title", image.title);
        image.alt = display.title;
        image.title = display.title;
      });
    });

    return translatedRows;
  }

  function applyCardListTranslations(cardsById) {
    let translatedRows = 0;

    cardsById.forEach((card, databaseId) => {
      translatedRows += applyCardListCardTranslation(databaseId, card);
    });

    return translatedRows;
  }

  function applyCardListCardTranslation(databaseId, card) {
    let translatedRows = 0;
    const translatedTextContainers = new WeakSet();
    const scope = getCardListScopeSelector();

    document.querySelectorAll(`${scope} .t_row`).forEach((row) => {
      const input = row.querySelector("input.link_value");
      const link = row.querySelector("a[href*='card_search.action']");
      const rowCardId = extractCid((input && input.value) || (link && link.getAttribute("href")) || "");
      if (rowCardId !== databaseId) {
        return;
      }

      const display = getCardDisplayData(card);
      if (replaceDeckDetailRow(row, display) || replaceCardListSimpleRow(row, display)) {
        translatedRows += 1;
      }

      row.querySelectorAll("img").forEach((image) => {
        rememberOriginal(image, "alt", image.alt);
        rememberOriginal(image, "title", image.title);
        image.alt = display.title;
        image.title = display.title;
      });
    });

    document.querySelectorAll(`${scope} a[href*='card_search.action']`).forEach((link) => {
      if (extractCid(link.getAttribute("href") || "") !== databaseId || !link.querySelector("img")) {
        return;
      }

      const display = getCardDisplayData(card);
      rememberOriginal(link, "title", link.title);
      link.title = display.title;
      link.querySelectorAll("img").forEach((image) => {
        rememberOriginal(image, "alt", image.alt);
        rememberOriginal(image, "title", image.title);
        image.alt = display.title;
        image.title = display.title;
      });
      translatedRows += 1;
    });

    document.querySelectorAll(`${scope} tr`).forEach((row) => {
      if (row.closest(".t_row")) {
        return;
      }

      const input = row.querySelector("input.link_value");
      const link = row.querySelector("a[href*='card_search.action']");
      const rowCardId = extractCid((input && input.value) || (link && link.getAttribute("href")) || "");
      if (rowCardId !== databaseId) {
        return;
      }

      const display = getCardDisplayData(card);
      if (replaceDeckTextRow(row, display)) {
        translatedRows += 1;
      }
    });

    document.querySelectorAll(`${scope} input.link_value, ${scope} a[href*='card_search.action']`).forEach((node) => {
      const rowCardId = extractCid(node.value || node.getAttribute("href") || "");
      if (rowCardId !== databaseId) {
        return;
      }
      if (node.tagName === "A" && hasMatchingInputAncestor(node, rowCardId)) {
        return;
      }

      const container = getCardListTextContainer(node);
      if (!container || container.matches(".t_row") || container.closest(".t_row") || container.tagName === "TR") {
        return;
      }
      if (translatedTextContainers.has(container)) {
        return;
      }

      const display = getCardDisplayData(card);
      if (replaceCardListTextContainer(container, display)) {
        translatedTextContainers.add(container);
        translatedRows += 1;
      }
    });

    return translatedRows;
  }

  function getRelatedCardIds() {
    const ids = new Set();
    document.querySelectorAll("#relationCard input.link_value").forEach((input) => {
      const relatedCid = extractCid(input.value);
      if (relatedCid) {
        ids.add(relatedCid);
      }
    });

    return Array.from(ids);
  }

  function applyRelatedCardTranslations(cardsById) {
    let translatedRows = 0;

    document.querySelectorAll("#relationCard input.link_value").forEach((input) => {
      const card = cardsById.get(extractCid(input.value));
      const row = input.closest(".t_row");
      if (!card || !row) {
        return;
      }

      const display = getCardDisplayData(card);
      if (replaceDeckDetailRow(row, display)) {
        translatedRows += 1;
      }
    });

    return translatedRows;
  }

  function translateRelatedCardLabels() {
    const labels = {
      "\u95a2\u9023\u30ab\u30fc\u30c9": "Related Cards",
      "\u753b\u50cf\u8868\u793a": "Images",
      "\u30c6\u30ad\u30b9\u30c8\u8868\u793a": "Text",
    };
    const root = document.querySelector("#relationCard");
    if (!root) {
      return 0;
    }

    let translated = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes = [];

    while (walker.nextNode()) {
      textNodes.push(walker.currentNode);
    }

    textNodes.forEach((node) => {
      const originalText = node.textContent;
      const trimmed = originalText.trim();
      const translatedText = labels[trimmed];

      if (!translatedText) {
        return;
      }

      rememberOriginal(node, "textContent", originalText);
      node.textContent = originalText.replace(trimmed, translatedText);
      translated += 1;
    });

    return translated;
  }

  function translateLimitBadges() {
    const labels = {
      "\u7981\u6b62": "Forbidden",
      "\u7981\u6b62\u30ab\u30fc\u30c9": "Forbidden",
      "\u5236\u9650": "Limited",
      "\u5236\u9650\u30ab\u30fc\u30c9": "Limited",
      "\u6e96\u5236\u9650": "Semi-Limited",
      "\u6e96\u5236\u9650\u30ab\u30fc\u30c9": "Semi-Limited",
      "\u65b0\u898f\u30fb\u7981\u6b62": "Newly Forbidden",
      "\u65b0\u898f\u30fb\u5236\u9650": "Newly Limited",
      "\u65b0\u898f\u30fb\u6e96\u5236\u9650": "Newly Semi-Limited",
      "\u7981\u6b62 \u21d2 \u5236\u9650": "Forbidden -> Limited",
      "\u7981\u6b62 \u21d2 \u6e96\u5236\u9650": "Forbidden -> Semi-Limited",
      "\u7981\u6b62 \u21d2 \u89e3\u9664": "Forbidden -> Unlimited",
      "\u5236\u9650 \u21d2 \u7981\u6b62": "Limited -> Forbidden",
      "\u5236\u9650 \u21d2 \u6e96\u5236\u9650": "Limited -> Semi-Limited",
      "\u5236\u9650 \u21d2 \u89e3\u9664": "Limited -> Unlimited",
      "\u6e96\u5236\u9650 \u21d2 \u7981\u6b62": "Semi-Limited -> Forbidden",
      "\u6e96\u5236\u9650 \u21d2 \u5236\u9650": "Semi-Limited -> Limited",
      "\u6e96\u5236\u9650 \u21d2 \u89e3\u9664": "Semi-Limited -> Unlimited",
    };

    document.querySelectorAll(".lr_icon.fl p, .lr_icon.fl span, .forbidden_limited_ber .title").forEach((node) => {
      const originalText = node.textContent;
      const trimmed = cleanText(originalText);
      const translatedText = labels[trimmed];
      if (!translatedText) {
        return;
      }

      rememberOriginal(node, "textContent", originalText);
      node.textContent = originalText.replace(trimmed, translatedText);
    });

    document.querySelectorAll("[title*='\u5236\u9650'], [title*='\u7981\u6b62']").forEach((node) => {
      const originalTitle = node.getAttribute("title") || "";
      const translatedTitle = translateLimitTitle(originalTitle);
      if (translatedTitle === originalTitle) {
        return;
      }

      rememberOriginal(node, "title", originalTitle);
      node.setAttribute("title", translatedTitle);
    });
  }

  function translateLimitTitle(title) {
    return String(title || "")
      .replace(/\u3010\u7981\u6b62\u30ab\u30fc\u30c9\u3011\s*/g, "Forbidden: ")
      .replace(/\u3010\u6e96\u5236\u9650\u30ab\u30fc\u30c9\u3011\s*/g, "Semi-Limited: ")
      .replace(/\u3010\u5236\u9650\u30ab\u30fc\u30c9\u3011\s*/g, "Limited: ")
      .replace(/\u7981\u6b62\u30ab\u30fc\u30c9/g, "Forbidden")
      .replace(/\u6e96\u5236\u9650\u30ab\u30fc\u30c9/g, "Semi-Limited")
      .replace(/\u5236\u9650\u30ab\u30fc\u30c9/g, "Limited")
      .replace(/\u7981\u6b62/g, "Forbidden")
      .replace(/\u6e96\u5236\u9650/g, "Semi-Limited")
      .replace(/\u5236\u9650/g, "Limited");
  }

  function translateCardStaticLabels() {
    const labels = {
      "\u3053\u306e\u30ab\u30fc\u30c9\u3092\u4f7f\u7528\u3057\u305f\u30c7\u30c3\u30ad\u3092\u691c\u7d22": "Search Decks That Use This Card",
      "\u3053\u306e\u30ab\u30fc\u30c9\u306e\u95a2\u9023\u30ab\u30fc\u30c9\u3092\u898b\u308b": "View Related Cards",
      "\u53ce\u9332\u30b7\u30ea\u30fc\u30ba": "Sets",
    };
    const roots = [
      document.querySelector("#title_msg"),
      document.querySelector("#CardSet"),
      document.querySelector("#update_list"),
    ].filter(Boolean);
    let translated = 0;

    roots.forEach((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const textNodes = [];

      while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
      }

      textNodes.forEach((node) => {
        const originalText = node.textContent;
        let translatedText = originalText;

        Object.keys(labels).forEach((label) => {
          translatedText = translatedText.split(label).join(labels[label]);
        });

        if (translatedText === originalText) {
          return;
        }

        rememberOriginal(node, "textContent", originalText);
        node.textContent = translatedText;
        translated += 1;
      });
    });

    return translated;
  }

  function translateReleaseSeries(card) {
    const updateList = document.querySelector("#update_list");
    if (!updateList) {
      return 0;
    }

    const setNamesByCode = getSetNamesByCode(card);
    let translated = 0;

    updateList.querySelectorAll(".t_row").forEach((row) => {
      const numberNode = row.querySelector(".card_number");
      const packNameNode = row.querySelector(".pack_name");
      if (!numberNode || !packNameNode) {
        return;
      }

      const setCode = cleanText(numberNode.textContent);
      const englishSetName = getSetNameForCode(setNamesByCode, setCode);
      if (!englishSetName) {
        return;
      }

      const displaySetName = applyJapaneseSetNameSuffixes(englishSetName, packNameNode.textContent);
      numberNode.classList.add("rushdb-yugipedia-set-code");
      packNameNode.classList.add("rushdb-yugipedia-pack-name");
      rememberOriginal(packNameNode, "textContent", packNameNode.textContent);
      packNameNode.textContent = displaySetName;
      translated += 1;
    });

    return translated;
  }

  function getSetNamesByCode(card) {
    const fields = card && card.fields ? card.fields : {};
    const setText = fields.jp_sets || fields.ja_sets || fields.en_sets || "";
    const map = new Map();

    String(setText).split(/\r?\n/).forEach((line) => {
      const parts = line.split(";").map((part) => cleanWikiText(part));
      const code = parts[0];
      const setName = parts[1];
      if (code && setName) {
        map.set(code.toUpperCase(), setName);
      }
    });

    return map;
  }

  function getSetNameForCode(setNamesByCode, setCode) {
    const normalizedCode = cleanText(setCode).toUpperCase();
    if (!normalizedCode) {
      return "";
    }

    const exact = setNamesByCode.get(normalizedCode);
    if (exact) {
      return exact;
    }

    const packPrefix = normalizedCode.replace(/-JP[A-Z]?\d+$/i, "");
    if (!packPrefix) {
      return "";
    }

    for (const [code, setName] of setNamesByCode.entries()) {
      if (code.replace(/-JP[A-Z]?\d+$/i, "") === packPrefix) {
        return setName;
      }
    }

    return "";
  }

  function applyJapaneseSetNameSuffixes(englishSetName, japaneseSetName) {
    const suffixes = [];
    if (/\u7279\u5178\u30ab\u30fc\u30c9/.test(japaneseSetName)) {
      suffixes.push("Promo Cards");
    }

    if (suffixes.length === 0) {
      return englishSetName;
    }

    return `${englishSetName} (${suffixes.join(", ")})`;
  }

  function translateRushDbGlobalHeaders() {
    const labels = {
      "\u30ab\u30fc\u30c9\u691c\u7d22": "Card Search",
      "\u30c7\u30c3\u30ad\u691c\u7d22": "Deck Search",
      "\u30ea\u30df\u30c3\u30c8\u30ec\u30ae\u30e5\u30ec\u30fc\u30b7\u30e7\u30f3": "Limit Regulation",
    };

    document.querySelectorAll("h1, h3, h3 span, .btn_top h3 span").forEach((node) => {
      const isSplitLimitRegulation = node.matches && node.matches("span.type2");
      if (node.children && node.children.length > 0 && !isSplitLimitRegulation) {
        return;
      }

      const originalText = node.textContent;
      const trimmed = cleanText(originalText);
      const translated = translateGlobalHeaderText(trimmed, labels);
      if (!translated || translated === trimmed) {
        return;
      }

      if (isSplitLimitRegulation && translated === "Limit Regulation") {
        rememberOriginal(node, "innerHTML", node.innerHTML);
        node.replaceChildren(document.createTextNode("Limit"), document.createElement("br"), document.createTextNode("Regulation"));
      } else {
        rememberOriginal(node, "textContent", originalText);
        node.textContent = originalText.replace(trimmed, translated);
      }
    });
  }

  function translateGlobalHeaderText(text, labels) {
    let translated = labels[text] || text;
    Object.keys(labels).sort((a, b) => b.length - a.length).forEach((label) => {
      translated = translated.split(label).join(labels[label]);
    });
    return translated;
  }

  function translateCardListHeader(cardsById) {
    const englishSetName = getMostLikelyListSetName(cardsById);
    if (!englishSetName) {
      return 0;
    }

    const titleNode = document.querySelector("#broad_title h1 strong") || document.querySelector("#broad_title h1");
    const originalJapaneseTitle = titleNode ? cleanText(titleNode.textContent) : getJapaneseTitleFromDocument();
    const displaySetName = applyJapaneseSetNameSuffixes(englishSetName, originalJapaneseTitle);
    let translated = 0;

    if (titleNode) {
      rememberOriginal(titleNode, "innerHTML", titleNode.innerHTML);
      titleNode.textContent = displaySetName;
      translated += 1;
    }

    const breadcrumbTitle = document.querySelector("#pan_nav li.oneline");
    if (breadcrumbTitle) {
      rememberOriginal(breadcrumbTitle, "textContent", breadcrumbTitle.textContent);
      breadcrumbTitle.textContent = displaySetName;
      translated += 1;
    }

    translatePackTitleInText(document.querySelector("#title_msg"), originalJapaneseTitle, displaySetName);
    translatePackTitleInText(document.querySelector("title"), originalJapaneseTitle, displaySetName);
    return translated;
  }

  function getMostLikelyListSetName(cardsById) {
    const counts = new Map();
    cardsById.forEach((card) => {
      getSetNamesByCode(card).forEach((setName) => {
        counts.set(setName, (counts.get(setName) || 0) + 1);
      });
    });

    let bestName = "";
    let bestCount = 0;
    counts.forEach((count, setName) => {
      if (count > bestCount) {
        bestName = setName;
        bestCount = count;
      }
    });

    return bestName;
  }

  function getJapaneseTitleFromDocument() {
    return cleanText(document.title.split("|")[0] || "");
  }

  function translatePackTitleInText(root, japaneseTitle, englishTitle) {
    if (!root || !japaneseTitle || !englishTitle) {
      return 0;
    }

    let translated = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes = [];

    while (walker.nextNode()) {
      textNodes.push(walker.currentNode);
    }

    textNodes.forEach((node) => {
      const originalText = node.textContent;
      const translatedText = originalText.split(japaneseTitle).join(englishTitle);
      if (translatedText === originalText) {
        return;
      }

      rememberOriginal(node, "textContent", originalText);
      node.textContent = translatedText;
      translated += 1;
    });

    return translated;
  }

  function translateCardListStaticLabels() {
    const labels = Object.assign({
      "\u753b\u50cf\u8868\u793a": "Images",
      "\u30c6\u30ad\u30b9\u30c8\u8868\u793a": "Text",
      "\u5168\u3066": "All",
      "\u30ab\u30fc\u30c9\u30ca\u30f3\u30d0\u30fc\u9806": "Card Number",
      "50\u97f3\u9806": "Name",
      "\u30ec\u30d9\u30eb\uff08\u5927\u304d\u3044\u9806\uff09": "Level (High to Low)",
      "\u30ec\u30d9\u30eb\uff08\u5c0f\u3055\u3044\u9806\uff09": "Level (Low to High)",
      "ATK\u9806\uff08\u5927\u304d\u3044\u9806\uff09": "ATK (High to Low)",
      "ATK\u9806\uff08\u5c0f\u3055\u3044\u9806\uff09": "ATK (Low to High)",
      "DEF\u9806\uff08\u5927\u304d\u3044\u9806\uff09": "DEF (High to Low)",
      "DEF\u9806\uff08\u5c0f\u3055\u3044\u9806\uff09": "DEF (Low to High)",
      "\u767a\u58f2\u65e5(\u53e4\u3044\u9806)": "Release Date (Oldest)",
      "\u767a\u58f2\u65e5(\u65b0\u3057\u3044\u9806)": "Release Date (Newest)",
      "\u516c\u958b\u65e5": "Release Date",
    }, getRarityTranslationLabels());
    const cardSearchMaps = getCardSearchTranslationMaps();
    const roots = [
      document.querySelector("#mode_set"),
      document.querySelector(".sort_set"),
      document.querySelector("#icon_sort"),
      document.querySelector("#previewed"),
      document.querySelector("#form_search"),
    ].filter(Boolean);
    let translated = 0;

    roots.forEach((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const textNodes = [];

      while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
      }

      textNodes.forEach((node) => {
        const originalText = node.textContent;
        let translatedText = translateCardListText(originalText, labels);
        if (translatedText === originalText && root.id === "form_search") {
          translatedText = translateCardSearchText(originalText, cardSearchMaps);
        }
        if (translatedText === originalText) {
          return;
        }

        rememberOriginal(node, "textContent", originalText);
        node.textContent = translatedText;
        translated += 1;
      });
    });

    translated += translateCardSearchFormValues(cardSearchMaps);
    translated += translateRarityBadges(labels);
    return translated;
  }

  function translateForbiddenLimitedStaticLabels() {
    const labels = {
      "\u30ea\u30df\u30c3\u30c8\u30ec\u30ae\u30e5\u30ec\u30fc\u30b7\u30e7\u30f3": "Limit Regulation",
      "\u66f4\u65b0\u306e\u3042\u3063\u305f\u30ab\u30fc\u30c9": "Updated Cards",
      "\u66f4\u65b0\u65e5": "Updated",
      "\u66f4\u65b0": "Updated",
      "\u7981\u6b62\u30ab\u30fc\u30c9": "Forbidden Cards",
      "\u5236\u9650\u30ab\u30fc\u30c9": "Limited Cards",
      "\u6e96\u5236\u9650\u30ab\u30fc\u30c9": "Semi-Limited Cards",
      "\u5236\u9650\u89e3\u9664\u3055\u308c\u305f\u30ab\u30fc\u30c9": "No Longer Limited Cards",
      "\u7981\u6b62": "Forbidden",
      "\u5236\u9650": "Limited",
      "\u6e96\u5236\u9650": "Semi-Limited",
      "\u30c7\u30c3\u30ad\uff08\u30a8\u30af\u30b9\u30c8\u30e9\u30c7\u30c3\u30ad\u30fb\u30b5\u30a4\u30c9\u30c7\u30c3\u30ad\u3092\u542b\u3080\uff09\u306e\u69cb\u7bc9\u306b\u4f7f\u7528\u3067\u304d\u306a\u3044\u30ab\u30fc\u30c9\u3067\u3059\u3002": "Cards that cannot be used to build a Deck, including the Extra Deck and Side Deck.",
      "\u30c7\u30c3\u30ad\uff08\u30a8\u30af\u30b9\u30c8\u30e9\u30c7\u30c3\u30ad\u30fb\u30b5\u30a4\u30c9\u30c7\u30c3\u30ad\u3092\u542b\u3080\uff09\u306b\uff11\u679a\u307e\u3067\u5165\u308c\u3089\u308c\u308b\u30ab\u30fc\u30c9\u3067\u3059\u3002": "Cards limited to 1 copy in your Deck, including the Extra Deck and Side Deck.",
      "\u30c7\u30c3\u30ad\uff08\u30a8\u30af\u30b9\u30c8\u30e9\u30c7\u30c3\u30ad\u30fb\u30b5\u30a4\u30c9\u30c7\u30c3\u30ad\u3092\u542b\u3080\uff09\u306b\uff12\u679a\u307e\u3067\u5165\u308c\u3089\u308c\u308b\u30ab\u30fc\u30c9\u3067\u3059\u3002": "Cards limited to 2 copies in your Deck, including the Extra Deck and Side Deck.",
      "\u5236\u9650\u304c\u89e3\u9664\u3055\u308c\u305f\u30ab\u30fc\u30c9\u3067\u3059\u3002": "Cards whose restrictions have been removed.",
    };
    const roots = [
      document.querySelector("#article_body"),
      document.querySelector("#broad_title"),
      document.querySelector("#pan_nav"),
      document.querySelector("#f_update_date"),
    ].filter(Boolean);
    let translated = 0;

    roots.forEach((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
      }

      textNodes.forEach((node) => {
        if (node.parentElement && ["SCRIPT", "STYLE"].includes(node.parentElement.tagName)) {
          return;
        }

        const originalText = node.textContent;
        const translatedText = translateForbiddenLimitedText(originalText, labels);
        if (translatedText === originalText) {
          return;
        }

        rememberOriginal(node, "textContent", originalText);
        node.textContent = translatedText;
        translated += 1;
      });
    });

    return translated;
  }

  function translateForbiddenLimitedText(text, labels) {
    let translated = text;
    Object.keys(labels).sort((a, b) => b.length - a.length).forEach((label) => {
      translated = translated.split(label).join(labels[label]);
    });
    translated = translated.replace(/(\d+)\s*\u679a/g, "$1 cards");
    return translated;
  }

  function getRarityTranslationLabels() {
    return {
      "\u30ce\u30fc\u30de\u30eb\u4ed5\u69d8": "Normal",
      "\u30ec\u30a2\u4ed5\u69d8": "Rare",
      "\u30b9\u30fc\u30d1\u30fc\u30ec\u30a2\u4ed5\u69d8": "Super Rare",
      "\u30a6\u30eb\u30c8\u30e9\u30ec\u30a2\u4ed5\u69d8": "Ultra Rare",
      "\u30b7\u30fc\u30af\u30ec\u30c3\u30c8\u30ec\u30a2\u4ed5\u69d8": "Secret Rare",
      "Parallel\u30b9\u30fc\u30d1\u30fc\u30ec\u30a2": "Parallel Super Rare",
      "Parallel \u30b9\u30fc\u30d1\u30fc\u30ec\u30a2": "Parallel Super Rare",
      "\u30d1\u30e9\u30ec\u30eb\u4ed5\u69d8\u30b9\u30fc\u30d1\u30fc\u30ec\u30a2": "Parallel Super Rare",
      "\u30d1\u30e9\u30ec\u30eb\u4ed5\u69d8 \u30b9\u30fc\u30d1\u30fc\u30ec\u30a2": "Parallel Super Rare",
      "\u30d1\u30e9\u30ec\u30eb\u4ed5\u69d8\u30a6\u30eb\u30c8\u30e9\u30ec\u30a2": "Parallel Ultra Rare",
      "\u30d1\u30e9\u30ec\u30eb\u4ed5\u69d8 \u30a6\u30eb\u30c8\u30e9\u30ec\u30a2": "Parallel Ultra Rare",
      "\u30d1\u30e9\u30ec\u30eb\u4ed5\u69d8": "Parallel",
      "\u30e9\u30c3\u30b7\u30e5\u30ec\u30a2\u4ed5\u69d8": "Rush Rare",
      "\u30aa\u30fc\u30d0\u30fc\u30e9\u30c3\u30b7\u30e5\u30ec\u30a2\u4ed5\u69d8": "Over Rush Rare",
    };
  }

  function translateRarityBadges(labels) {
    let translated = 0;
    document.querySelectorAll(".lr_icon.rid span, [class*='t_rid_'] > span").forEach((span) => {
      const originalText = span.textContent;
      const translatedText = translateCardListText(originalText, labels);
      if (translatedText === originalText) {
        return;
      }

      rememberOriginal(span, "textContent", originalText);
      span.textContent = translatedText;
      translated += 1;
    });

    return translated;
  }

  function translateCardListText(text, labels) {
    const trimmed = text.trim();
    let translated = labels[trimmed] || text;

    if (translated === text) {
      Object.keys(labels).sort((a, b) => b.length - a.length).forEach((label) => {
        translated = translated.split(label).join(labels[label]);
      });
    }

    translated = translated.replace(/\u5168\s*(\d+)\s*\u7a2e/g, "$1 cards");
    translated = translated.replace(/(\d{4})\u5e74(\d{2})\u6708(\d{2})\u65e5/g, "$1-$2-$3");
    return translated;
  }

  function translateDeckSearchStaticLabels() {
    const maps = getDeckSearchTranslationMaps();
    const roots = Array.from(new Set([
      document.querySelector("#pan_nav"),
      document.querySelector("#broad_title"),
      document.querySelector("#title_msg"),
      document.querySelector("#form_search"),
      document.querySelector("#article_body"),
    ].filter(Boolean)));
    let translated = 0;

    roots.forEach((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const textNodes = [];

      while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
      }

      textNodes.forEach((node) => {
        if (node.parentElement && ["SCRIPT", "STYLE"].includes(node.parentElement.tagName)) {
          return;
        }

        const originalText = node.textContent;
        const translatedText = translateDeckSearchText(originalText, maps);
        if (translatedText === originalText) {
          return;
        }

        rememberOriginal(node, "textContent", originalText);
        node.textContent = translatedText;
        translated += 1;
      });
    });

    translated += translateDeckSearchFormValues(maps);
    const translatedTitle = translateDeckSearchText(document.title, maps);
    if (translatedTitle !== document.title) {
      rememberOriginal(document, "title", document.title);
      document.title = translatedTitle;
    }
    return translated;
  }

  function translateDeckSearchFormValues(maps) {
    let translated = 0;

    document.querySelectorAll("#article_body input, #article_body option").forEach((node) => {
      if (node.tagName === "INPUT" && ["button", "submit", "reset"].includes((node.type || "").toLowerCase())) {
        const originalValue = node.value;
        const translatedValue = translateDeckSearchText(originalValue, maps);
        if (translatedValue !== originalValue) {
          rememberOriginal(node, "value", originalValue);
          node.value = translatedValue;
          translated += 1;
        }
      }

      if (node.tagName === "OPTION") {
        const originalLabel = node.label;
        const translatedLabel = translateDeckSearchText(originalLabel, maps);
        if (translatedLabel !== originalLabel) {
          rememberOriginal(node, "label", originalLabel);
          node.label = translatedLabel;
          translated += 1;
        }
      }
    });

    return translated;
  }

  function translateDeckSearchText(text, maps) {
    const trimmed = text.trim();
    const exact = maps.exact[trimmed];
    if (exact) {
      return text.replace(trimmed, exact);
    }

    let translated = text;
    maps.inline.forEach(([from, to]) => {
      translated = translated.split(from).join(to);
    });
    maps.codeInline.forEach(([from, to]) => {
      translated = translated.replace(new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(from)}(?=$|[^A-Za-z0-9])`, "g"), `$1${to}`);
    });

    translated = translated.replace(/\u691c\u7d22\u7d50\u679c\s*([\d,]+)\s*\u4ef6\u4e2d\s*([\d,]+)\s*[～〜-]\s*([\d,]+)\s*\u4ef6\u3092\u8868\u793a/g, "Showing $2-$3 of $1 results");
    translated = translated.replace(/\u691c\u7d22\u7d50\u679c\s*([\d,]+)\s*\u4ef6/g, "$1 results");
    translated = translated.replace(/\u691c\s+\u7d22/g, "Search");
    return translated;
  }

  function translateCardSearchStaticLabels() {
    const maps = getCardSearchTranslationMaps();
    const roots = Array.from(new Set([
      document.querySelector("#pan_nav"),
      document.querySelector("#broad_title"),
      document.querySelector("#title_msg"),
      document.querySelector("#form_search"),
      document.querySelector("#article_body"),
    ].filter(Boolean)));
    let translated = 0;

    roots.forEach((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const textNodes = [];

      while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
      }

      textNodes.forEach((node) => {
        if (node.parentElement && node.parentElement.closest("script, style, svg")) {
          return;
        }

        const originalText = node.textContent;
        const translatedText = translateCardSearchText(originalText, maps);
        if (translatedText === originalText) {
          return;
        }

        rememberOriginal(node, "textContent", originalText);
        node.textContent = translatedText;
        translated += 1;
      });
    });

    translated += translateCardSearchFormValues(maps);
    const translatedTitle = translateCardSearchText(document.title, maps);
    if (translatedTitle !== document.title) {
      rememberOriginal(document, "title", document.title);
      document.title = translatedTitle;
    }
    return translated;
  }

  function translateCardSearchFormValues(maps) {
    let translated = 0;

    document.querySelectorAll("#article_body input, #article_body button, #article_body option, #article_body [title], #article_body [alt], #article_body [placeholder], #article_body [aria-label]").forEach((node) => {
      if (node.tagName === "INPUT" && ["button", "submit", "reset"].includes((node.type || "").toLowerCase())) {
        const originalValue = node.value;
        const translatedValue = translateCardSearchText(originalValue, maps);
        if (translatedValue !== originalValue) {
          rememberOriginal(node, "value", originalValue);
          node.value = translatedValue;
          translated += 1;
        }
      }

      if (node.tagName === "OPTION") {
        const originalText = node.textContent;
        const translatedText = translateCardSearchText(originalText, maps);
        if (translatedText !== originalText) {
          rememberOriginal(node, "textContent", originalText);
          node.textContent = translatedText;
          translated += 1;
        }

        const originalLabel = node.label;
        const translatedLabel = translateCardSearchText(originalLabel, maps);
        if (translatedLabel !== originalLabel) {
          rememberOriginal(node, "label", originalLabel);
          node.label = translatedLabel;
          translated += 1;
        }
      }

      translated += translateCardSearchProperty(node, "title", maps);
      translated += translateCardSearchProperty(node, "alt", maps);
      translated += translateCardSearchProperty(node, "placeholder", maps);
      translated += translateCardSearchProperty(node, "ariaLabel", maps);
    });

    return translated;
  }

  function translateCardSearchProperty(node, prop, maps) {
    if (!(prop in node) || !node[prop]) {
      return 0;
    }

    const originalValue = node[prop];
    const translatedValue = translateCardSearchText(originalValue, maps);
    if (translatedValue === originalValue) {
      return 0;
    }

    rememberOriginal(node, prop, originalValue);
    node[prop] = translatedValue;
    return 1;
  }

  function translateCardSearchText(text, maps) {
    const original = String(text);
    const trimmed = cleanText(original);
    if (!trimmed) {
      return original;
    }

    const exact = maps.exact[trimmed];
    if (exact) {
      const leading = original.match(/^\s*/)[0];
      const trailing = original.match(/\s*$/)[0];
      return `${leading}${exact}${trailing}`;
    }

    let translated = original;
    maps.inline.forEach(([from, to]) => {
      translated = translated.split(from).join(to);
    });
    translated = translated.replace(/\u691c\s+\u7d22/g, "Search");
    translated = translated.replace(/\u5168\s*(\d+)\s*\u7a2e/g, "$1 cards");
    translated = translated.replace(/(\d+)\u4ef6\u305a\u3064\u8868\u793a/g, "Show $1 per page");
    translated = translated.replace(/(\d{4})\u5e74(\d{2})\u6708(\d{2})\u65e5/g, "$1-$2-$3");
    return translated;
  }

  function getCardSearchTranslationMaps() {
    const entries = [
      ["絞り込みたいその他の項目を選択してください、AndあるいはOrで絞り込みます", "Search by Card Type (and/or)"],
      ["遊戯王ニューロン(ラッシュデュエル カードデータベース)とは", "About Yu-Gi-Oh! Neuron (Rush Duel Card Database)"],
      ["遊戯王ニューロン(ラッシュデュエル カードデータベース)", "Yu-Gi-Oh! Neuron (Rush Duel Card Database)"],
      ["遊戯王ニューロン ( ラッシュデュエル カードデータベース ）", "Yu-Gi-Oh! Neuron (Rush Duel Card Database)"],
      ["カードが初めて発売した日や登場した日で絞り込みます。", "Filter cards by the first release date or date they first appeared."],
      ["ATK(攻撃力)で絞り込みます、最大は5000です", "Search by ATK (Max. 5000)"],
      ["DEF(守備力)で絞り込みます、最大は5000です", "Search by DEF (Max. 5000)"],
      ["0から12までのレベルあるいはランクを絞り込みます", "Search by Level/Rank (0-12)"],
      ["リンクを数値またはマーカーの位置で絞り込みます。", "Search by Link Rating/Arrow Direction"],
      ["JavaScript を有効にしてください", "Please enable JavaScript in your browser."],
      ["詳細な位置情報を利用した機能について", "Regarding Features That Use Precise Geolocation Data"],
      ["絞り込みたい属性を選択してください", "Search by Attribute"],
      ["絞り込みたい種族を選択してください", "Search by Monster Type"],
      ["ペンデュラムスケールで絞り込みます", "Search by Pendulum Scale"],
      ["絞り込みたい効果を選択してください", "Search by Icon"],
      ["除外したい項目を選択してください", "Exclude Selected Items"],
      ["全ての遊戯王ラッシュデュエルカードをカード検索する事ができます。", "Search all Yu-Gi-Oh! Rush Duel cards."],
      ["公開日よりカード検索し詳細情報を参照する事ができます。", "You can search cards and view details from their publication date."],
      ["検索条件を入力してから検索ボタンを押してください。", "Enter search conditions, then press the Search button."],
      ["English(Asia)", "English (Asia)"],
      ["この設定でよろしいですか？", "Is this setting okay?"],
      ["リミットレギュレーション", "Limit Regulation"],
      ["「ペンデュラム効果」検索", "Search by Pendulum Effect"],
      ["注目カテゴリーランキング", "Trending Category Ranking"],
      ["「カードテキスト」検索", "Search by Card Text"],
      ["すべてのカードから検索", "Search All Cards"],
      ["プライバシーノーティス", "Privacy Notice"],
      ["人気デッキランキング", "Popular Deck Ranking"],
      ["Portugues", "Portuguese"],
      ["オメガサイキック族", "Omega Psychic"],
      ["Cookie 設定", "Cookie Settings"],
      ["「カードNo」検索", "Search by Card Number"],
      ["モンスターカード", "Monster Cards"],
      ["マイカードリスト", "My Card List"],
      ["Français", "French"],
      ["Italiano", "Italian"],
      ["ペンデュラム効果", "Pendulum Effect"],
      ["発売日の新しい順", "Sort by Release Date (Desc.)"],
      ["「カード名」検索", "Search by Card Name"],
      ["キーワードを入力", "Enter Keyword"],
      ["レジェンドカード", "Legend Card"],
      ["条件を絞って検索", "Search Filters"],
      ["ギャラクシー族", "Galaxy"],
      ["遊び方はこちら", "How to Play"],
      ["カードテキスト", "Card Text"],
      ["サイトポリシー", "Site Policy"],
      ["ハイドラゴン族", "High Dragon"],
      ["Español", "Spanish"],
      ["Deutsch", "German"],
      ["レベル／ランク", "Level/Rank"],
      ["サイボーグ族", "Cyborg"],
      ["サイバース族", "Cyberse"],
      ["特典・同梱系", "Promos & Bundled Cards"],
      ["サイキック族", "Psychic"],
      ["フュージョン", "Fusion"],
      ["お問い合わせ", "Contact"],
      ["ペンデュラム", "Pendulum"],
      ["アンデット族", "Zombie"],
      ["カード誕生日", "Card Birthday"],
      ["レジェンド", "Legend"],
      ["魔法使い族", "Spellcaster"],
      ["天界戦士族", "Celestial Warrior"],
      ["その他項目", "Card Type"],
      ["リチュアル", "Ritual"],
      ["同意しない", "Decline"],
      ["デッキ検索", "Deck Search"],
      ["魔法カード", "Spell Cards"],
      ["ドラゴン族", "Dragon"],
      ["初回発売日", "Initial Release Date"],
      ["ご利用規約", "Terms of Use"],
      ["マキシマム", "Maximum"],
      ["フィールド", "Field"],
      ["カード検索", "Card Search"],
      ["魔導騎士族", "Magical Knight"],
      ["キャンセル", "Cancel"],
      ["通常カード", "Normal Card"],
      ["カードNo", "Card Number"],
      ["マイデッキ", "My Deck"],
      ["罠カード", "Trap Cards"],
      ["ログイン", "Log in"],
      ["----", "Any"],
      ["除外項目", "Excluded Items"],
      ["トレンド", "Trends"],
      ["爬虫類族", "Reptile"],
      ["カード名", "Card Name"],
      ["同意する", "Agree"],
      ["ユニオン", "Union"],
      ["✕閉じる", "Close"],
      ["獣戦士族", "Beast-Warrior"],
      ["一般商品", "Products"],
      ["確認する", "Confirm"],
      ["機械族", "Machine"],
      ["恐竜族", "Dinosaur"],
      ["鳥獣族", "Winged Beast"],
      ["岩石族", "Rock"],
      ["Ｑ＆Ａ", "Q&A"],
      ["昆虫族", "Insect"],
      ["戦士族", "Warrior"],
      ["幻竜族", "Wyrm"],
      ["悪魔族", "Fiend"],
      ["植物族", "Plant"],
      ["光属性", "LIGHT"],
      ["変更後", "After Change"],
      ["天使族", "Fairy"],
      ["闇属性", "DARK"],
      ["水属性", "WATER"],
      ["終了日", "End Date"],
      ["地属性", "EARTH"],
      ["ホーム", "Home"],
      ["風属性", "WIND"],
      ["海竜族", "Sea Serpent"],
      ["炎属性", "FIRE"],
      ["日本語", "Japanese"],
      ["リンク", "Link"],
      ["開始日", "Start Date"],
      ["変更前", "Before Change"],
      ["獣族", "Beast"],
      ["効果", "Icon"],
      ["右上", "Top-Right"],
      ["戻る", "Back"],
      ["左上", "Top-Left"],
      ["水族", "Aqua"],
      ["右下", "Bottom-Right"],
      ["左下", "Bottom-Left"],
      ["種族", "Monster Type"],
      ["通常", "Normal"],
      ["検　索", "Search"],
      ["検索", "Search"],
      ["한글", "Korean"],
      ["装備", "Equip"],
      ["属性", "Attribute"],
      ["収録", "Included in"],
      ["雷族", "Thunder"],
      ["炎族", "Pyro"],
      ["魚族", "Fish"],
      ["左", "Left"],
      ["下", "Bottom"],
      ["上", "Top"],
      ["～", "to"],
      ["右", "Right"],
      ["x", "Clear"],
    ];
    const exact = {};
    const inlineTerms = {};

    entries.forEach(([jp, en]) => {
      exact[jp] = en;
      if (jp.length > 1) {
        inlineTerms[jp] = en;
      }
    });

    return {
      exact,
      inline: Object.entries(inlineTerms).sort((a, b) => b[0].length - a[0].length),
    };
  }

  function sortDeckSearchCategories() {
    const categoryCount = sortDeckSearchOptionGroup("#dckCategoryMst", (option) => {
      const label = cleanText(option.textContent || option.label);
      return label.startsWith("\ud83e\uddd1") ? "secondary" : "primary";
    });
    const tagCount = sortDeckSearchOptionGroup("#dckTagMst", (option) => {
      const originalText = getOriginalOptionText(option);
      return isDeckSearchAttributeOrTypeTag(originalText) ? "secondary" : "primary";
    });

    return categoryCount + tagCount;
  }

  function sortDeckSearchOptionGroup(selector, getGroup) {
    const select = document.querySelector(selector);
    if (!select) {
      return 0;
    }

    const options = Array.from(select.options);
    const placeholders = [];
    const primary = [];
    const secondary = [];

    options.forEach((option, index) => {
      rememberOriginal(option, "rushdbOriginalIndex", index);
      const label = cleanText(option.textContent || option.label);
      if (!option.value || /^[-\s]+$/.test(label)) {
        placeholders.push(option);
      } else if (getGroup(option) === "secondary") {
        secondary.push(option);
      } else {
        primary.push(option);
      }
    });

    const compareOptions = (a, b) => {
      return cleanText(a.textContent || a.label).localeCompare(cleanText(b.textContent || b.label), "en", {
        numeric: true,
        sensitivity: "base",
      });
    };

    primary.sort(compareOptions);
    secondary.sort(compareOptions);
    [...placeholders, ...primary, ...secondary].forEach((option) => select.appendChild(option));
    return primary.length + secondary.length;
  }

  function restoreDeckSearchCategoryOrder() {
    restoreDeckSearchOptionOrder("#dckCategoryMst");
    restoreDeckSearchOptionOrder("#dckTagMst");
  }

  function restoreDeckSearchOptionOrder(selector) {
    const select = document.querySelector(selector);
    if (!select) {
      return;
    }

    Array.from(select.options)
      .sort((a, b) => {
        const aRecord = deckOriginals.get(a) || {};
        const bRecord = deckOriginals.get(b) || {};
        return (aRecord.rushdbOriginalIndex || 0) - (bRecord.rushdbOriginalIndex || 0);
      })
      .forEach((option) => select.appendChild(option));
  }

  function getOriginalOptionText(option) {
    const record = deckOriginals.get(option) || {};
    return cleanText(record.textContent || record.label || option.textContent || option.label);
  }

  function isDeckSearchAttributeOrTypeTag(text) {
    const value = cleanText(text);
    return /^(?:\u95c7|\u5149|\u6c34|\u708e|\u5730|\u98a8)\u5c5e\u6027$/.test(value)
      || /^[\u30a0-\u30ff\u4e00-\u9fff]+\u65cf$/.test(value)
      || /^(?:DARK|LIGHT|WATER|FIRE|EARTH|WIND|Dragon|Zombie|Fiend|Pyro|Sea Serpent|Rock|Machine|Fish|Dinosaur|Insect|Beast|Beast-Warrior|Plant|Aqua|Warrior|Winged Beast|Fairy|Spellcaster|Thunder|Reptile|Psychic|Wyrm|Cyberse|Cyborg|Magical Knight|High Dragon|Celestial Warrior|Omega Psychic|Galaxy)$/i.test(value);
  }

  function getDeckSearchTranslationMaps() {
    const exact = {
      "デッキ検索": "Deck Search",
      "デッキ名": "Deck Name",
      "デッキコード": "Deck Code",
      "カード名": "Card Name",
      "キーワード": "Keyword",
      "デッキスタイル": "Deck Style",
      "登録カテゴリ": "Registered Category",
      "登録タグ": "Registered Tag",
      "お気に入り": "Favorites",
      "キャラクタ": "Character",
      "トーナメント": "Tournament",
      "コンセプト": "Concept",
      "前方一致": "Starts With",
      "後方一致": "Ends With",
      "選択": "Select",
      "選択をクリア": "Clear Selection",
      "検索": "Search",
      "闇": "DARK",
      "光": "LIGHT",
      "水": "WATER",
      "炎": "FIRE",
      "地": "EARTH",
      "風": "WIND",
      "クリア": "Clear",
      "ホーム": "Home",
      "条件を絞って検索": "Refine Search",
      "デッキレシピ記入シートをダウンロードする": "Download Deck Recipe Entry Sheet",
      "Deckレシピ記入シートをダウンロードする": "Download Deck Recipe Entry Sheet",
      "デッキ名を入力": "Enter Deck Name",
      "カード名を入力": "Enter Card Name",
      "キーワードを入力": "Enter Keyword",
      "カードゲームID": "Card Game ID",
      "更新日付の降順, デッキ名昇順": "Update Date Descending, Deck Name Ascending",
      "更新日付の昇順, デッキ名昇順": "Update Date Ascending, Deck Name Ascending",
      "デッキ名の昇順, 更新日付の昇順": "Deck Name Ascending, Update Date Ascending",
      "デッキ名の降順, 更新日付の昇順": "Deck Name Descending, Update Date Ascending"
    };
    const spreadsheetCategories = [{"value":["OTS","OuTerverSe"],"Count":2},{"value":["安立マニャ","🧑 Manya Atachi"],"Count":2},{"value":["安立ミミ","🧑 Mimi Imimi"],"Count":2},{"value":["安立ヨシオ","🧑 Yosh Imimi"],"Count":2},{"value":["アニマジカ","Animagica"],"Count":2},{"value":["アビスカイト","Abysskite"],"Count":2},{"value":["洗井新太","🧑 Buff Grimes"],"Count":2},{"value":["アリ","Ant"],"Count":2},{"value":["有栖川ジャンゴ","🧑 Janko Entant"],"Count":2},{"value":["暗黒騎士ガイア","Gaia the Fierce Knight"],"Count":2},{"value":["暗黒シャイン王アークトーク","Dark Shine King Arktalk"],"Count":2},{"value":["アンティーク・ギア","Ancient Gear"],"Count":2},{"value":["アーツエンジェル","Arts Angel"],"Count":2},{"value":["行手内造","🧑 Naizo Ikatenai"],"Count":2},{"value":["イス","Chair"],"Count":2},{"value":["いとをかし","Itowokashi"],"Count":2},{"value":["海","Umi"],"Count":2},{"value":["エクスキューティー","Excutie"],"Count":2},{"value":["エポック","🧑 Epoch"],"Count":2},{"value":["焔魔","Blaze Fiend"],"Count":2},{"value":["王道遊歩","🧑 Yuamu Ohdo"],"Count":2},{"value":["王道遊我","🧑 Yuga Ohdo"],"Count":2},{"value":["王道遊飛","🧑 Yuhi Ohdo"],"Count":2},{"value":["大森麺三郎","🧑 Saburamen"],"Count":2},{"value":["お注射天使リリー","Injection Fairy Lily"],"Count":2},{"value":["御前乃ウシロウ","🧑 Toombs"],"Count":2},{"value":["オリジナル","Original"],"Count":2},{"value":["オーティス","🧑 Otes"],"Count":2},{"value":["カイゾー","🧑 Kaizo"],"Count":2},{"value":["怪談","Kaidan / Ghost Story"],"Count":2},{"value":["カオス・ソルジャー","Black Luster Soldier"],"Count":2},{"value":["花牙","Gekka / Flower Fang"],"Count":2},{"value":["籠たま子","🧑 Tamako Kago"],"Count":2},{"value":["かっぱ","Kappa"],"Count":2},{"value":["火麺","Kamen / Fire Noodle"],"Count":2},{"value":["合羽井テル","🧑 Teru Kawai"],"Count":2},{"value":["ガクティング","Gakuting"],"Count":2},{"value":["ガジェット","Gadget"],"Count":2},{"value":["楽鬼","Gakki / Music Princess"],"Count":2},{"value":["ガーゼット","Garzett"],"Count":2},{"value":["輝鋼超竜デヴァスター・オケアビス","Devastar Okeabyss, the Steel Shine Super Dragon"],"Count":2},{"value":["CAN：D","Can:D"],"Count":2},{"value":["霧島ロア","🧑 Roa Kassidy"],"Count":2},{"value":["霧島ロミン","🧑 Romin Kassidy"],"Count":2},{"value":["霧島ロンドン","🧑 London Kassidy"],"Count":2},{"value":["霧島ロヴィアン","🧑 Rovian Kassidy"],"Count":2},{"value":["ギャラクティカ・オブリビオン","Galactica Oblivion"],"Count":2},{"value":["クァイドゥール・ベルギャー","🧑 Kuaidul Velgear"],"Count":2},{"value":["グラット石田","🧑 Glatt Ishida"],"Count":2},{"value":["グレート・モス","Great Moth"],"Count":2},{"value":["恵雷の精霊","Graceful Thunder Spirit"],"Count":2},{"value":["ケミカライズ","Chemicalize"],"Count":2},{"value":["幻壊","Genkai / Phantom Ruin"],"Count":2},{"value":["幻書鳩の騎士ナイト・ヴィジョン","Knight Vision, the Phantom Pigeon Knight"],"Count":2},{"value":["幻刃","Phantom Blade / Genba"],"Count":2},{"value":["コスモス姫","Princess Cosmos"],"Count":2},{"value":["昆遁忍虫","Konton Ninja Insect / Chaotic Ninja Insect"],"Count":2},{"value":["後藤ハント","🧑 Hunt Goto"],"Count":2},{"value":["ゴーハ・ユウナ","🧑 Yuna Goha"],"Count":2},{"value":["西園寺ネイル","🧑 Nail Saionji"],"Count":2},{"value":["最強戦旗","Strongest Battle Flag"],"Count":2},{"value":["彩光のプリマギターナ","Prima Guitarna the Shining Superstar"],"Count":2},{"value":["サイバースパイス","Cyber Spice"],"Count":2},{"value":["サイバー・ドラゴン","Cyber Dragon"],"Count":2},{"value":["サンダービート","Thunderbeat"],"Count":2},{"value":["ザイオン","🧑 Zaion"],"Count":2},{"value":["ザ☆ドラギアス","The☆Dragias"],"Count":2},{"value":["ザ☆ニャンデスター","The☆Meowdestar"],"Count":2},{"value":["ザ☆ルーグ","🧑 The☆Luge"],"Count":2},{"value":["精霊義賊","Spirit Thief"],"Count":2},{"value":["シューバッハ","🧑 Schubel Quill"],"Count":2},{"value":["深淵海竜アビス・クラーケン","Abyss Kraken, the Deep-Sea Dragon"],"Count":2},{"value":["深淵竜神アビス・ポセイドラ","Abyss Poseidra, the Abyss Dragon Deity"],"Count":2},{"value":["真実爆郎","🧑 Scoop Pilman"],"Count":2},{"value":["CPT","Cybersepice"],"Count":2},{"value":["邪犬","Mean Mutt"],"Count":2},{"value":["ジャージ・デビルズ","Jersey Devils"],"Count":2},{"value":["獣機界","Beast Gear World"],"Count":2},{"value":["ジョインテック","Jointech"],"Count":2},{"value":["人造人間","Jinzo"],"Count":2},{"value":["スイーツ過去子","🧑 Sweets Kakoko"],"Count":2},{"value":["寿司天使","Sushi Angel"],"Count":2},{"value":["スターキャット","Star Cat"],"Count":2},{"value":["スターズハンド","Star’s Hand"],"Count":2},{"value":["スパークハーツ","Sparkhearts"],"Count":2},{"value":["スピード","Speed"],"Count":2},{"value":["スーパーマキシマムトレモロガールズ","Super Maximum Tremolo Girls"],"Count":2},{"value":["スーパー・ウォー・ライオン","Super War-Lion"],"Count":2},{"value":["ズウィージョウ","🧑 Zuwijo Zwil Velgear"],"Count":2},{"value":["聖麗","Sacred Splendor"],"Count":2},{"value":["セバスチャン","🧑 Seatbastian"],"Count":2},{"value":["セブンスロード","Sevens Road"],"Count":2},{"value":["セレブローズ","Celeb Rose"],"Count":2},{"value":["千年の盾","Millennium Shield"],"Count":2},{"value":["絶望狂魔","Despair Demon"],"Count":2},{"value":["ゼラ","Zera"],"Count":2},{"value":["蒼救","Azure Savior / Soukyu"],"Count":2},{"value":["蒼月学人","🧑 Gavin Sogetsu"],"Count":2},{"value":["蒼月マグト","🧑 Maguto Sogetsu"],"Count":2},{"value":["蒼月マナブ","🧑 Maddox Sogetsu"],"Count":2},{"value":["象明寺キャタピリオ","🧑 Caterpillio Elephantus"],"Count":2},{"value":["タイガー","🧑 Tiadosia “Tiger” Kallister"],"Count":2},{"value":["平月太","🧑 Tyler Getz"],"Count":2},{"value":["田崎ギャリアン","🧑 Galian Townsend"],"Count":2},{"value":["田崎さん","🧑 Galixon Townsend"],"Count":2},{"value":["タマボット","Tamabot"],"Count":2},{"value":["ダイスマイト","Dicemite"],"Count":2},{"value":["ダイナ－ミクス","Dynamix"],"Count":2},{"value":["ダークマイスター","🧑 Dark Meister"],"Count":2},{"value":["ダークマター","Dark Matter"],"Count":2},{"value":["ダークメン","🧑 Darkmen"],"Count":2},{"value":["チュパ太郎","🧑 Chupataro Kaburagi"],"Count":2},{"value":["帝王","Monarch"],"Count":2},{"value":["手乗りドラコ","Tiny Draco"],"Count":2},{"value":["纏竜","Wrapped Dragon"],"Count":2},{"value":["ディアン・ケト","Dian Keto"],"Count":2},{"value":["ディノワ","🧑 Dinois Velgear"],"Count":2},{"value":["デビルズ・ミラー","Fiend’s Mirror"],"Count":2},{"value":["デーモンの召喚","Summoned Skull"],"Count":2},{"value":["トランザム・ライナック","Transam Linac"],"Count":2},{"value":["ドラギアス","Dragias"],"Count":2},{"value":["ドラゴニック","Dragonic"],"Count":2},{"value":["ナナホ","🧑 Nanaho Nanahoshi"],"Count":2},{"value":["七星テンテン","🧑 Tenten Nanahoshi"],"Count":2},{"value":["七星蘭世","🧑 Rayne Nanahoshi"],"Count":2},{"value":["七星ランラン","🧑 Ranran Nanahoshi"],"Count":2},{"value":["七星凛之介","🧑 Rino Nanahoshi"],"Count":2},{"value":["ヌードル宇宙子","🧑 Celestia Noodlina"],"Count":2},{"value":["N","Normal Monsters"],"Count":2},{"value":["ネクメイド","Necmaid"],"Count":2},{"value":["猫山シュレディンガー","🧑 Schrodinger Nekoyama"],"Count":2},{"value":["ノムラトダマス","🧑 Nomuratodamas"],"Count":2},{"value":["ハイテクドラゴン","High-Tech Dragon"],"Count":2},{"value":["ハイブリッドライブ","Hybridrive"],"Count":2},{"value":["白佛カン","🧑 Kan Hakubutsu"],"Count":2},{"value":["はぐれ使い魔","Stray Familiar"],"Count":2},{"value":["ハトラップ","🧑 Pigetrap"],"Count":2},{"value":["ハングリーバーガー","Hungry Burger"],"Count":2},{"value":["叛骨","Defiant Soul"],"Count":2},{"value":["ハンディーレディ","Handy Lady"],"Count":2},{"value":["ハーピィ","Harpie"],"Count":2},{"value":["バスター・ブレイダー","Buster Blader"],"Count":2},{"value":["バニシング・ヘリアカルライザー","Vanishing Heliacal Riser"],"Count":2},{"value":["秘密捜査官","Secret Investigator"],"Count":2},{"value":["火雷神サンダーボールド","Thunderbold, the Blazing Thunder Deity"],"Count":2},{"value":["平森みつ子","🧑 Terza Flatwood"],"Count":2},{"value":["HERO","HERO"],"Count":2},{"value":["ビック・バイパー","Vic Viper"],"Count":2},{"value":["F・G・D","Five-Headed Dragon"],"Count":2},{"value":["フィンガー地下子","🧑 Terra Kneadalina"],"Count":2},{"value":["フォローウィング・ワールド","Follow-Wing World"],"Count":2},{"value":["フラッシュ海深子","🧑 Flash Umiko"],"Count":2},{"value":["ブラスデス","Brassdes"],"Count":2},{"value":["ブラックカオス","Black Chaos"],"Count":2},{"value":["ブラック・マジシャン","Dark Magician"],"Count":2},{"value":["青眼の白龍","Blue-Eyes White Dragon"],"Count":2},{"value":["プライム","Praime"],"Count":2},{"value":["P・M","Plasmatic"],"Count":2},{"value":["プリンセスG","🧑 Princess G"],"Count":2},{"value":["ベリーフレッシュ","Berry Fresh"],"Count":2},{"value":["報道","News / Reporting"],"Count":2},{"value":["ボチ","🧑 Bochi / Graves"],"Count":2},{"value":["巻寿司子","🧑 Sushiko Maki"],"Count":2},{"value":["マグナム・オーバーロード","Magnum Overlord"],"Count":2},{"value":["マグネット・ウォリアー","Magnet Warrior"],"Count":2},{"value":["マグロ","Maguro / Tuna"],"Count":2},{"value":["間黒七海","🧑 Skipjack"],"Count":2},{"value":["魔将","Fiendish Commander / Mashou"],"Count":2},{"value":["魔法羊女メェ～グちゃん","Magical Sheep Girl Meeeg-chan"],"Count":2},{"value":["夢中","Delirium"],"Count":2},{"value":["六葉アサカ","🧑 Asaka Mutsuba"],"Count":2},{"value":["六葉アサナ","🧑 Asana Mutsuba"],"Count":2},{"value":["ムーンフォース","Moonforce"],"Count":2},{"value":["冥跡","Monumenthes"],"Count":2},{"value":["メタリオン","Metarion"],"Count":2},{"value":["焼肉","Yakiniku / Grilled Meat"],"Count":2},{"value":["野球","Baseball"],"Count":2},{"value":["八木ニック","🧑 Nick Yagi"],"Count":2},{"value":["ユウオウ","🧑 Yuo Goha"],"Count":2},{"value":["ユウカ","🧑 Yuka Goha"],"Count":2},{"value":["湧軍機","Molten Martial Machine"],"Count":2},{"value":["ユウジーン","🧑 Yujin Goha"],"Count":2},{"value":["ユウディアス・ベルギャー","🧑 Yudias Velgear"],"Count":2},{"value":["ユウラン","🧑 Yuran Goha"],"Count":2},{"value":["ユウロ","🧑 Yuro Goha"],"Count":2},{"value":["ユグドラゴ","Yggdrago"],"Count":2},{"value":["要塞クジラ","Fortress Whale"],"Count":2},{"value":["R・HERO","Rising HERO"],"Count":2},{"value":["ライトニング・ボルコンドル","Lightning Bolcondor"],"Count":2},{"value":["ラヴ","🧑 Love"],"Count":2},{"value":["竜宮トレモロ","🧑 Tremolo Ryugu"],"Count":2},{"value":["竜宮フェイザー","🧑 Phaser Ryugu"],"Count":2},{"value":["流聖のプリアージュ","Pliage the Sacred Shooting Star"],"Count":2},{"value":["ルーク","🧑 Lucidien “Luke” Kallister"],"Count":2},{"value":["霊使い","Charmer"],"Count":2},{"value":["レジェンド・マジシャン","Legend Magician"],"Count":2},{"value":["真紅眼の黒竜","Red-Eyes Black Dragon"],"Count":2},{"value":["ロイヤルデモンズ","Royal Rebel’s"],"Count":2},{"value":["ワイト","Skull Servant"],"Count":2},{"value":["Vi－FRND","Vi-FRND"],"Count":2},{"value":["ヴォイドアルヴ","Voidarve"],"Count":2},{"value":["ヴォイドヴェルグ","Voidvelgr"],"Count":2},{"value":["ヴォルカライズ","Volcalize"],"Count":2}];
    const spreadsheetTags = [{"value":["公式紹介デッキ","Official Featured Decks"],"Count":2},{"value":["エリアチャンピオンシップ","Area Championship"],"Count":2},{"value":["ギャラクシーカップ","Galaxy Cup"],"Count":2},{"value":["トーナメントバトル","Tournament Battle"],"Count":2},{"value":["大会優勝デッキ/入賞デッキ","Tournament Winner/Placing Decks"],"Count":2},{"value":["インストラクターデッキ","Instructor Deck"],"Count":2},{"value":["みんなのおススメデッキ","Everyone\u0027s Recommended Decks"],"Count":2},{"value":["闇属性","DARK"],"Count":2},{"value":["光属性","LIGHT"],"Count":2},{"value":["水属性","WATER"],"Count":2},{"value":["炎属性","FIRE"],"Count":2},{"value":["地属性","EARTH"],"Count":2},{"value":["風属性","WIND"],"Count":2},{"value":["ドラゴン族","Dragon"],"Count":2},{"value":["アンデット族","Zombie"],"Count":2},{"value":["悪魔族","Fiend"],"Count":2},{"value":["炎族","Pyro"],"Count":2},{"value":["海竜族","Sea Serpent"],"Count":2},{"value":["岩石族","Rock"],"Count":2},{"value":["機械族","Machine"],"Count":2},{"value":["魚族","Fish"],"Count":2},{"value":["恐竜族","Dinosaur"],"Count":2},{"value":["昆虫族","Insect"],"Count":2},{"value":["獣族","Beast"],"Count":2},{"value":["獣戦士族","Beast-Warrior"],"Count":2},{"value":["植物族","Plant"],"Count":2},{"value":["水族","Aqua"],"Count":2},{"value":["戦士族","Warrior"],"Count":2},{"value":["鳥獣族","Winged Beast"],"Count":2},{"value":["天使族","Fairy"],"Count":2},{"value":["魔法使い族","Spellcaster"],"Count":2},{"value":["雷族","Thunder"],"Count":2},{"value":["爬虫類族","Reptile"],"Count":2},{"value":["サイキック族","Psychic"],"Count":2},{"value":["幻竜族","Wyrm"],"Count":2},{"value":["サイバース族","Cyberse"],"Count":2},{"value":["サイボーグ族","Cyborg"],"Count":2},{"value":["魔導騎士族","Magical Knight"],"Count":2},{"value":["ハイドラゴン族","High Dragon"],"Count":2},{"value":["天界戦士族","Celestial Warrior"],"Count":2},{"value":["オメガサイキック族","Omega Psychic"],"Count":2},{"value":["ギャラクシー族","Galaxy"],"Count":2},{"value":["オリジナル","Original"],"Count":2},{"value":["公式大会用","Official Tournament"],"Count":2}];
    const inlineTerms = {};
    const codeTerms = {
      "OTS": "OuTerverSe",
      "CAN：D": "Can:D",
      "CAN : D": "Can:D",
      "CAN:D": "Can:D",
      "Can：D": "Can:D",
      "Can : D": "Can:D",
      "Can:D": "Can:D",
      "CPT": "Cybersepice",
      "F・G・D": "Five-Headed Dragon",
      "R・HERO": "Rising HERO",
      "P・M": "Plasmatic"
    };
    const alwaysInlineTerms = {
      "デッキ検索": "Deck Search",
      "条件を絞って検索": "Refine Search",
      "デッキレシピ記入シートをダウンロードする": "Download Deck Recipe Entry Sheet",
      "Deckレシピ記入シートをダウンロードする": "Download Deck Recipe Entry Sheet",
      "お気に入り": "Favorites",
      "デッキスタイル": "Deck Style",
      "登録カテゴリ": "Registered Category",
      "登録タグ": "Registered Tag",
      "トーナメント": "Tournament",
      "コンセプト": "Concept",
      "キャラクタ": "Character",
      "デッキ名": "Deck Name",
      "更新日付": "Update Date",
      "昇順": "Ascending",
      "降順": "Descending"
    };

    spreadsheetCategories.forEach((entry) => {
      const [jp, en] = entry.value || entry;
      exact[jp] = en;
      if (jp.length > 1 && !codeTerms[jp]) {
        inlineTerms[jp] = en;
      }
    });
    spreadsheetTags.forEach((entry) => {
      const [jp, en] = entry.value || entry;
      exact[jp] = en;
      if (jp.length > 1 && !codeTerms[jp]) {
        inlineTerms[jp] = en;
      }
    });
    Object.keys(codeTerms).forEach((jp) => {
      exact[jp] = codeTerms[jp];
    });
    Object.entries(alwaysInlineTerms).forEach(([jp, en]) => {
      exact[jp] = en;
      inlineTerms[jp] = en;
    });

    return {
      exact,
      inline: Object.entries(inlineTerms).sort((a, b) => b[0].length - a[0].length),
      codeInline: Object.entries(codeTerms).sort((a, b) => b[0].length - a[0].length),
    };
  }
  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function translateDeckStaticLabels() {
    const labels = {
      "\u30c6\u30ad\u30b9\u30c8\u8a73\u7d30\u8868\u793a": "Detailed Text",
      "\u30c6\u30ad\u30b9\u30c8\u8868\u793a": "Text",
      "\u753b\u50cf\u8868\u793a": "Images",
      "\u30e2\u30f3\u30b9\u30bf\u30fc\u30ab\u30fc\u30c9": "Monster Cards",
      "\u9b54\u6cd5\u30ab\u30fc\u30c9": "Spell Cards",
      "\u7f60\u30ab\u30fc\u30c9": "Trap Cards",
      "\u30e1\u30a4\u30f3\u30c7\u30c3\u30ad": "Main Deck",
      "\u30a8\u30af\u30b9\u30c8\u30e9\u30c7\u30c3\u30ad": "Extra Deck",
      "\u30b5\u30a4\u30c9\u30c7\u30c3\u30ad": "Side Deck",
      "\u30e1\u30a4\u30f3\u30c7\u30c3\u30ad\u5408\u8a08": "Main Deck",
      "\u30a8\u30af\u30b9\u30c8\u30e9\u30c7\u30c3\u30ad\u5408\u8a08": "Extra Deck",
      "\u30b5\u30a4\u30c9\u30c7\u30c3\u30ad\u5408\u8a08": "Side Deck",
    };
    const deckSearchMaps = getDeckSearchTranslationMaps();
    const roots = [
      document.querySelector("#mode_set"),
      document.querySelector("#num_total"),
      document.querySelector("#deck_text"),
      document.querySelector("#deck_detailtext"),
      document.querySelector("#deck_image"),
      document.querySelector("#broad_title"),
      document.querySelector("#title_msg"),
      document.querySelector("#pan_nav"),
      document.querySelector("#article_body"),
    ].filter(Boolean);
    let translated = 0;

    roots.forEach((root) => {
      const isDeckCardListRoot = ["deck_text", "deck_detailtext", "deck_image"].includes(root.id);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const textNodes = [];

      while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
      }

      textNodes.forEach((node) => {
        if (root.id === "article_body" && node.parentElement && node.parentElement.closest("#deck_text, #deck_detailtext, #deck_image")) {
          return;
        }
        if (node.parentElement && ["SCRIPT", "STYLE"].includes(node.parentElement.tagName)) {
          return;
        }

        const originalText = node.textContent;
        const trimmed = originalText.trim();
        let translatedText = labels[trimmed];
        if (translatedText) {
          translatedText = originalText.replace(trimmed, translatedText);
        } else if (isDeckCardListRoot) {
          return;
        } else {
          translatedText = translateDeckSearchText(originalText, deckSearchMaps);
        }

        if (translatedText === originalText) {
          return;
        }

        rememberOriginal(node, "textContent", originalText);
        node.textContent = translatedText;
        translated += 1;
      });
    });

    return translated;
  }

  function replaceDeckTextRow(row, display) {
    const nameNode = getDeckTextNameNode(row);
    if (!nameNode) {
      return false;
    }

    rememberOriginal(nameNode, "textContent", nameNode.textContent);
    nameNode.textContent = display.title;
    rememberOriginal(row, "title", row.title);
    row.title = display.title;
    return true;
  }

  function replaceDeckDetailRow(row, display) {
    const nameNode = row.querySelector(".box_card_name .card_name");
    if (!nameNode) {
      return false;
    }

    rememberOriginal(nameNode, "textContent", nameNode.textContent);
    nameNode.textContent = display.title;

    const attributeBox = row.querySelector(".box_card_attribute");
    const attributeLabel = getCardListAttributeLabel(display);
    if (attributeBox && attributeLabel) {
      const attributeText = Array.from(attributeBox.children).find((child) => child.tagName === "SPAN");
      const icon = attributeBox.querySelector("img");
      if (attributeText) {
        rememberOriginal(attributeText, "textContent", attributeText.textContent);
        attributeText.textContent = attributeLabel;
      }
      if (icon) {
        rememberOriginal(icon, "alt", icon.alt);
        rememberOriginal(icon, "title", icon.title);
        icon.alt = attributeLabel;
        icon.title = attributeLabel;
      }
    }

    translateCardListBadge(row.querySelector(".box_card_effect"), getCardListPropertyLabel(display));

    const levelText = row.querySelector(".box_card_level_rank > span");
    if (levelText && display.level) {
      rememberOriginal(levelText, "textContent", levelText.textContent);
      levelText.textContent = `Level ${display.level}`;
    }

    const kindText = row.querySelector(".card_info_species_and_other_item > span");
    if (kindText && display.kindText) {
      rememberOriginal(kindText, "textContent", kindText.textContent);
      kindText.textContent = `[ ${display.kindText} ]`;
    }

    const textBox = row.querySelector(".box_card_text");
    if (textBox) {
      rememberOriginal(textBox, "innerHTML", textBox.innerHTML);
      replaceTextBoxContent(textBox, display);
    }

    return true;
  }

  function replaceCardListSimpleRow(row, display) {
    const nameNode = row.querySelector(".card_name .name");
    if (!nameNode) {
      return false;
    }

    rememberOriginal(nameNode, "textContent", nameNode.textContent);
    nameNode.textContent = display.title;
    rememberOriginal(row, "title", row.title);
    row.title = display.title;

    const attributeBox = row.querySelector(".element .item_set span");
    const attributeText = getCardListAttributeLabel(display);
    if (attributeBox && attributeText) {
      rememberOriginal(attributeBox, "innerHTML", attributeBox.innerHTML);
      const icon = attributeBox.querySelector("img");
      attributeBox.replaceChildren();
      if (icon) {
        rememberOriginal(icon, "alt", icon.alt);
        rememberOriginal(icon, "title", icon.title);
        icon.alt = attributeText;
        icon.title = attributeText;
        attributeBox.appendChild(icon);
        attributeBox.appendChild(document.createTextNode(" "));
      }
      attributeBox.appendChild(document.createTextNode(attributeText));
    }

    const kindBox = row.querySelector(".element .other span");
    if (kindBox && display.kindText) {
      rememberOriginal(kindBox, "textContent", kindBox.textContent);
      kindBox.textContent = `[${display.kindText}]`;
    }

    const levelBox = row.querySelector(".num_set > span");
    if (levelBox && display.level) {
      rememberOriginal(levelBox, "innerHTML", levelBox.innerHTML);
      const icon = levelBox.querySelector("img");
      levelBox.replaceChildren();
      if (icon) {
        rememberOriginal(icon, "alt", icon.alt);
        rememberOriginal(icon, "title", icon.title);
        icon.alt = "Level";
        icon.title = "Level";
        levelBox.appendChild(icon);
        levelBox.appendChild(document.createTextNode(" "));
      }
      levelBox.appendChild(document.createTextNode(`Level ${display.level}`));
    }

    return true;
  }

  function getCardListAttributeLabel(display) {
    if (display.attribute) {
      return display.attribute;
    }

    if (/^Spell(?:\s+Card)?$/i.test(display.cardType || "")) {
      return "Spell";
    }

    if (/^Trap(?:\s+Card)?$/i.test(display.cardType || "")) {
      return "Trap";
    }

    return "";
  }

  function getCardListPropertyLabel(display) {
    return cleanWikiText(display && display.property);
  }

  function translateCardListBadge(container, preferredLabel) {
    if (!container) {
      return false;
    }

    const textNode = Array.from(container.children).find((child) => child.tagName === "SPAN");
    if (!textNode) {
      return false;
    }

    const originalText = cleanText(textNode.textContent);
    const translated = cleanWikiText(preferredLabel) || getCardListBadgeLabel(originalText);
    if (!translated || translated === originalText) {
      return false;
    }

    rememberOriginal(textNode, "textContent", textNode.textContent);
    textNode.textContent = translated;

    const icon = container.querySelector("img");
    if (icon) {
      rememberOriginal(icon, "alt", icon.alt);
      rememberOriginal(icon, "title", icon.title);
      icon.alt = translated;
      icon.title = translated;
    }

    return true;
  }

  function getCardListBadgeLabel(value) {
    const labels = {
      "\u901a\u5e38": "Normal",
      "\u30d5\u30a3\u30fc\u30eb\u30c9": "Field",
      "\u88c5\u5099": "Equip",
      "\u6c38\u7d9a": "Continuous",
      "\u901f\u653b": "Quick-Play",
      "\u5100\u5f0f": "Ritual",
      "\u30ab\u30a6\u30f3\u30bf\u30fc": "Counter",
    };
    return labels[cleanText(value)] || "";
  }

  function getDeckTextNameNode(row) {
    const icon = row.querySelector("td.card_name .icon");
    if (icon) {
      const iconName = Array.from(icon.children).find((child) => {
        return child.tagName === "SPAN" && child.id !== "legend" && !child.closest("#legend");
      });
      if (iconName) {
        return iconName;
      }
    }

    return row.querySelector("td.card_name a[href*='card_search.action']")
      || row.querySelector("td.card_name .card_name")
      || row.querySelector("td.card_name span:not(#legend)")
      || row.querySelector("a[href*='card_search.action']");
  }

  function getCardListTextContainer(node) {
    if (params.get("mode") !== "2") {
      return null;
    }

    if (node.tagName === "A" && node.querySelector("img")) {
      return null;
    }

    const targetCardId = extractCid(node.value || node.getAttribute("href") || "");
    let current = node.parentElement;
    while (current && current.id !== "card_list") {
      if (current.matches(".t_row") || current.tagName === "TR") {
        return null;
      }

      const cardIds = getCardIdsInElement(current);
      if (cardIds.size === 1 && cardIds.has(targetCardId) && !current.querySelector("img") && getCardListTextNameNode(current)) {
        return current;
      }

      current = current.parentElement;
    }

    return null;
  }

  function replaceCardListTextContainer(container, display) {
    const nameNode = getCardListTextNameNode(container);
    if (!nameNode) {
      return false;
    }

    rememberOriginal(nameNode, "textContent", nameNode.textContent);
    nameNode.textContent = display.title;
    rememberOriginal(container, "title", container.title);
    container.title = display.title;
    return true;
  }

  function getCardListTextNameNode(container) {
    if (container.matches(".card_name a[href*='card_search.action'], .card_name .card_name, .card_name span:not(#legend), .card_name")) {
      return container;
    }

    return container.querySelector(".card_name a[href*='card_search.action']")
      || container.querySelector(".card_name .card_name")
      || container.querySelector(".card_name span:not(#legend)")
      || container.querySelector(".card_name")
      || container.querySelector("a[href*='card_search.action']");
  }

  function getCardIdsInElement(element) {
    const ids = new Set();
    element.querySelectorAll("input.link_value, a[href*='card_search.action']").forEach((node) => {
      const cardId = extractCid(node.value || node.getAttribute("href") || "");
      if (cardId) {
        ids.add(cardId);
      }
    });
    return ids;
  }

  function hasMatchingInputAncestor(node, cardId) {
    let current = node.parentElement;
    while (current && current.id !== "card_list") {
      const input = current.querySelector("input.link_value");
      if (input && extractCid(input.value) === cardId) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  function replaceTextBoxContent(textBox, display) {
    textBox.replaceChildren();

    const lines = [];
    display.preface.forEach((text) => lines.push(["", text]));
    if (display.requirement) {
      lines.push(["Requirement", display.requirement]);
    }
    if (display.effect) {
      lines.push(["Effect", display.effect]);
    }

    lines.forEach(([label, text], index) => {
      if (index > 0) {
        textBox.appendChild(document.createElement("br"));
      }

      if (label) {
        const strong = document.createElement("strong");
        strong.textContent = `${label}: `;
        textBox.appendChild(strong);
      }

      textBox.appendChild(document.createTextNode(text));
    });
  }

  function extractCid(value) {
    const match = String(value).match(/[?&]cid=(\d+)/);
    return match ? match[1] : "";
  }

  function rememberOriginal(node, prop, value) {
    if (!node) {
      return;
    }

    const record = deckOriginals.get(node) || {};
    if (!(prop in record)) {
      record[prop] = value;
      deckOriginals.set(node, record);
    }
  }

  function restoreDeckData() {
    deckOriginals.forEach((record, node) => {
      if ("isConnected" in node && !node.isConnected) {
        return;
      }

      Object.keys(record).forEach((prop) => {
        node[prop] = record[prop];
      });
    });
  }

  function replaceCardName(title) {
    const containers = document.querySelectorAll("#cardname.cardname, .sp.cardname");
    containers.forEach((container) => {
      const heading = container.querySelector("h1");
      if (!heading) {
        return;
      }

      container.querySelectorAll(".rushdb-yugipedia-english-card-name").forEach((node) => node.remove());
      removeHeadingHashMarkers(heading);

      const japaneseName = getOriginalJapaneseName(heading);
      let ruby = heading.querySelector(":scope > .ruby");
      if (!ruby) {
        ruby = document.createElement("span");
        ruby.className = "ruby";
        heading.prepend(ruby);
      }

      ruby.textContent = japaneseName;
      replaceHeadingMainText(heading, ruby, title);
    });

    document.querySelectorAll("[id^='card_image_'], [id^='thumbnail_card_image_'], [id^='pop_card_image_']").forEach((image) => {
      image.alt = title;
      image.title = title;
    });
  }

  function getOriginalJapaneseName(heading) {
    if (heading.dataset.rushdbOriginalJapaneseName) {
      return heading.dataset.rushdbOriginalJapaneseName;
    }

    const clone = heading.cloneNode(true);
    clone.querySelectorAll(".rushdb-yugipedia-english-card-name").forEach((node) => node.remove());
    removeHeadingHashMarkers(clone, true);
    const ruby = clone.querySelector(":scope > .ruby");
    const rubyText = ruby ? cleanText(ruby.textContent) : "";
    if (ruby) {
      ruby.remove();
    }

    const japaneseName = cleanText(clone.textContent) || rubyText;
    heading.dataset.rushdbOriginalJapaneseName = japaneseName;
    return japaneseName;
  }

  function replaceHeadingMainText(heading, ruby, title) {
    let replaced = false;
    Array.from(heading.childNodes).forEach((node) => {
      if (node === ruby) {
        return;
      }

      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent.trim()) {
          if (!replaced) {
            node.textContent = title;
            replaced = true;
          } else {
            node.textContent = "";
          }
        }
      }
    });

    if (!replaced) {
      ruby.insertAdjacentText("afterend", title);
    }
  }

  function removeHeadingHashMarkers(heading, remove) {
    Array.from(heading.childNodes).forEach((node) => {
      if (cleanText(node.textContent) !== "#") {
        return;
      }

      if (remove || node.nodeType === Node.ELEMENT_NODE) {
        node.remove();
        return;
      }

      if (node.nodeType === Node.TEXT_NODE) {
        rememberOriginal(node, "textContent", node.textContent);
        node.textContent = "";
      }
    });
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function replaceMonsterSummary({ attribute, level, types }) {
    const summary = getPrimarySummaryArea();
    if (!summary) {
      return;
    }

    const attributeBox = summary.querySelector(".frame.imgset .item_box");
    if (attribute && attributeBox) {
      const value = attributeBox.querySelector(".item_box_value");
      const icon = attributeBox.querySelector("img");
      if (value) {
        value.textContent = attribute;
      }
      if (icon) {
        icon.alt = attribute;
        icon.title = attribute;
      }
    }

    const levelBox = Array.from(summary.querySelectorAll(".frame.imgset .item_box"))
      .find((box) => {
        const icon = box.querySelector("img");
        const value = box.querySelector(".item_box_value");
        return (icon && /icon_level/.test(icon.src)) || (value && /level|\u30ec\u30d9\u30eb/i.test(value.textContent));
      });

    if (level && levelBox) {
      const value = levelBox.querySelector(".item_box_value");
      if (value) {
        value.textContent = `Level ${level}`;
      }
    }

    const species = summary.querySelector(".species");
    if (types && species) {
      species.replaceChildren();
      const span = document.createElement("span");
      span.textContent = types.split("/").map((part) => part.trim()).filter(Boolean).join(" / ");
      species.appendChild(span);
    }
  }

  function replaceSpellTrapSummary({ cardType, property }) {
    if (!cardType) {
      return;
    }

    const summary = getPrimarySummaryArea();
    if (!summary) {
      return;
    }

    const spellTrapBox = summary.querySelector(".item_box.t_center");
    if (!spellTrapBox) {
      return;
    }

    const title = spellTrapBox.querySelector(".item_box_title");
    const value = spellTrapBox.querySelector(".item_box_value");

    if (title) {
      title.textContent = cardType;
    }
    if (value) {
      value.textContent = property ? `${property} ${cardType}` : cardType;
    }
  }

  function replaceCardText({ requirement, effect, preface }) {
    const textBox = Array.from(document.querySelectorAll(".item_box_text"))
      .find((box) => box.querySelector(".text_title"));

    if (!textBox) {
      return;
    }

    const title = textBox.querySelector(".text_title");
    if (title) {
      title.textContent = "Card Text";
    }

    Array.from(textBox.childNodes).forEach((node) => {
      if (node !== title) {
        node.remove();
      }
    });

    const lines = [];
    if (Array.isArray(preface)) {
      preface.forEach((text) => {
        if (text) {
          lines.push(["", text]);
        }
      });
    }
    if (requirement) {
      lines.push(["Requirement", requirement]);
    }
    if (effect) {
      lines.push(["Effect", effect]);
    }

    if (lines.length === 0) {
      return;
    }

    lines.forEach(([label, text], index) => {
      if (index > 0) {
        textBox.appendChild(document.createElement("br"));
      }

      if (label) {
        const strong = document.createElement("strong");
        strong.textContent = `${label}: `;
        textBox.appendChild(strong);
      }
      textBox.appendChild(document.createTextNode(text));
    });
  }

  function getPrimarySummaryArea() {
    return document.querySelector("#CardTextSet > .CardText")
      || Array.from(document.querySelectorAll(".CardText")).find((node) => !node.classList.contains("CardLanguage"));
  }

  function cleanWikiText(value) {
    if (!value) {
      return "";
    }

    let text = String(value);
    text = text.replace(/<!--[\s\S]*?-->/g, "");
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, "");
    text = text.replace(/<ref\b[^/]*\/>/gi, "");
    text = text.replace(/\{\{Ruby\|([^|{}]+)\|[^{}]*\}\}/g, "$1");
    text = text.replace(/\{\{!}}/g, "|");
    text = text.replace(/\{\{(?:Sic|sic)\|([^{}|]+)[^{}]*\}\}/g, "$1");
    text = replaceWikiLinks(text);
    text = text.replace(/\{\{[^{}]*\}\}/g, "");
    text = text.replace(/'''?/g, "");
    text = text.replace(/&nbsp;/g, " ");
    text = decodeHtmlEntities(text);
    text = text.replace(/[ \t]+\n/g, "\n");
    text = text.replace(/\s+/g, " ");
    return text.trim();
  }

  function replaceWikiLinks(text) {
    return text.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?]]/g, (_match, page, label) => {
      return label || page;
    });
  }

  function decodeHtmlEntities(text) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = text;
    return textarea.value;
  }

  function normalizeField(value) {
    return cleanWikiText(value).trim();
  }

  function captureOriginalData() {
    const pcName = document.querySelector("#cardname.cardname");
    const spName = document.querySelector(".sp.cardname");
    const summary = getPrimarySummaryArea();
    const textBox = Array.from(document.querySelectorAll(".item_box_text"))
      .find((box) => box.querySelector(".text_title"));

    return {
      title: document.title,
      pcNameHtml: pcName ? pcName.innerHTML : null,
      spNameHtml: spName ? spName.innerHTML : null,
      summaryHtml: summary ? summary.innerHTML : null,
      textBoxHtml: textBox ? textBox.innerHTML : null,
      images: Array.from(document.querySelectorAll("[id^='card_image_'], [id^='thumbnail_card_image_'], [id^='pop_card_image_']"))
        .map((image) => ({
          element: image,
          alt: image.alt,
          title: image.title,
        })),
    };
  }

  function restoreOriginalData() {
    const pcName = document.querySelector("#cardname.cardname");
    const spName = document.querySelector(".sp.cardname");
    const summary = getPrimarySummaryArea();
    const textBox = Array.from(document.querySelectorAll(".item_box_text"))
      .find((box) => box.querySelector(".text_title"));

    document.title = originalData.title;

    if (pcName && originalData.pcNameHtml !== null) {
      pcName.innerHTML = originalData.pcNameHtml;
    }
    if (spName && originalData.spNameHtml !== null) {
      spName.innerHTML = originalData.spNameHtml;
    }
    if (summary && originalData.summaryHtml !== null) {
      summary.innerHTML = originalData.summaryHtml;
    }
    if (textBox && originalData.textBoxHtml !== null) {
      textBox.innerHTML = originalData.textBoxHtml;
    }

    originalData.images.forEach((imageData) => {
      if (!imageData.element.isConnected) {
        return;
      }
      imageData.element.alt = imageData.alt;
      imageData.element.title = imageData.title;
    });
  }

  function setStatus(message, isError, url, retryAction) {
    let status = document.getElementById("rushdb-yugipedia-english-status");
    if (!status) {
      status = document.createElement("div");
      status.id = "rushdb-yugipedia-english-status";
      status.style.cssText = [
        "margin: 8px 0",
        "padding: 6px 8px",
        "border: 1px solid #0f5d8f",
        "background: #eef8ff",
        "color: #10384f",
        "font-size: 12px",
        "line-height: 1.35",
      ].join(";");

      const deckSearchControls = isLabelOnlyPage ? document.getElementById("rushdb-yugipedia-deck-search-controls") : null;
      if (deckSearchControls) {
        deckSearchControls.prepend(status);
      } else {
        const anchor = getStatusAnchor();
        if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(status, anchor.nextSibling);
        } else {
          document.body.prepend(status);
        }
      }
    }

    status.style.borderColor = isError ? "#a33" : "#0f5d8f";
    status.style.background = isError ? "#fff0f0" : "#eef8ff";
    if (isDeckPage) {
      status.style.display = "flex";
      status.style.alignItems = "center";
      status.style.gap = "6px";
      status.style.flexWrap = "wrap";
    }
    status.replaceChildren();

    if (url) {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = message;
      link.className = "rushdb-yugipedia-status-message";
      status.appendChild(link);
    } else {
      const messageNode = document.createElement("span");
      messageNode.className = "rushdb-yugipedia-status-message";
      messageNode.textContent = message;
      status.appendChild(messageNode);
    }

    if (retryAction) {
      status.appendChild(document.createTextNode(" "));
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = retryAction.retryLabel || "Retry missing cards";
      button.style.cssText = [
        "margin-left: 8px",
        "padding: 2px 8px",
        "border: 1px solid #0f5d8f",
        "border-radius: 3px",
        "background: #fff",
        "color: #10384f",
        "font-size: 12px",
        "line-height: 1.3",
        "cursor: pointer",
      ].join(";");
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.disabled = true;
        try {
          await retryAction();
        } catch (error) {
          console.error("[RushDB Yugipedia English]", error);
          setStatus("Retry failed against the hosted database and Yugipedia.", true, null, retryAction);
        }
      });
      status.appendChild(button);
    }

    appendDeckYdkDownloadButton(status);
    appendDeckYdkeCopyButton(status);
    addSearchControlsMinimizeButton(status);
  }

  function appendDeckYdkDownloadButton(status) {
    if (!isDeckPage || !deckYdkeCopyState) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.id = "rushdb-yugipedia-download-ydk";
    button.textContent = isDeckExportUnavailable(deckYdkeCopyState) ? "YDK unavailable" : "Download YDK";
    button.disabled = isDeckExportUnavailable(deckYdkeCopyState);
    button.title = getDeckYdkButtonTitle(deckYdkeCopyState);
    button.style.cssText = getDeckExportButtonStyle("auto");

    if (button.disabled) {
      button.style.cursor = "not-allowed";
      button.style.opacity = "0.7";
    }

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (isDeckExportUnavailable(deckYdkeCopyState)) {
        return;
      }

      button.disabled = true;
      try {
        downloadTextFile(makeYdk(deckYdkeCopyState.deck), getDeckExportFilename("ydk"));
        button.disabled = false;
      } catch (error) {
        console.error("[RushDB Yugipedia English] Could not download YDK", error);
        button.disabled = false;
        button.textContent = "Download failed";
        setTimeout(() => {
          button.textContent = isDeckExportUnavailable(deckYdkeCopyState) ? "YDK unavailable" : "Download YDK";
        }, 2000);
      }
    });

    status.appendChild(button);
  }

  function appendDeckYdkeCopyButton(status) {
    if (!isDeckPage || !deckYdkeCopyState) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.id = "rushdb-yugipedia-copy-ydke";
    button.textContent = isDeckExportUnavailable(deckYdkeCopyState) ? "YDKE unavailable" : "Copy YDKE";
    button.disabled = isDeckExportUnavailable(deckYdkeCopyState);
    button.title = getDeckYdkeButtonTitle(deckYdkeCopyState);
    button.style.cssText = getDeckExportButtonStyle("");

    if (button.disabled) {
      button.style.cursor = "not-allowed";
      button.style.opacity = "0.7";
    }

    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (isDeckExportUnavailable(deckYdkeCopyState)) {
        return;
      }

      const originalText = button.textContent;
      button.disabled = true;
      try {
        await copyTextToClipboard(makeYdke(deckYdkeCopyState.deck));
        button.textContent = "Copied YDKE";
        setTimeout(() => {
          button.disabled = false;
          button.textContent = originalText;
        }, 1600);
      } catch (error) {
        console.error("[RushDB Yugipedia English] Could not copy YDKE", error);
        button.disabled = false;
        button.textContent = "Copy failed";
        setTimeout(() => {
          button.textContent = originalText;
        }, 2000);
      }
    });

    status.appendChild(button);
  }

  function isDeckExportUnavailable(state) {
    return !state || Boolean(state.loadError) || state.missing.length > 0;
  }

  function getDeckExportButtonStyle(marginLeft) {
    return [
      marginLeft ? `margin-left: ${marginLeft}` : "",
      "padding: 2px 8px",
      "border: 1px solid #0f5d8f",
      "border-radius: 3px",
      "background: #fff",
      "color: #10384f",
      "font-size: 12px",
      "line-height: 1.3",
      "cursor: pointer",
      "white-space: nowrap",
    ].filter(Boolean).join(";");
  }

  function getDeckYdkButtonTitle(state) {
    const baseTitle = getDeckExportProblemTitle(state);
    if (baseTitle) {
      return baseTitle;
    }

    const warning = state.ambiguous.length > 0
      ? ` ${state.ambiguous.length} duplicate-name match${state.ambiguous.length === 1 ? "" : "es"} used the first spreadsheet ID.`
      : "";
    return `Download .ydk file for EDOPro (${state.copiedCards}/${state.totalCards} cards).${warning}`;
  }

  function getDeckYdkeButtonTitle(state) {
    const baseTitle = getDeckExportProblemTitle(state);
    if (baseTitle) {
      return baseTitle;
    }

    const warning = state.ambiguous.length > 0
      ? ` ${state.ambiguous.length} duplicate-name match${state.ambiguous.length === 1 ? "" : "es"} used the first spreadsheet ID.`
      : "";
    return `Copy ydke:// URL for EDOPro (${state.copiedCards}/${state.totalCards} cards).${warning}`;
  }

  function getDeckExportProblemTitle(state) {
    if (!state) {
      return "";
    }

    if (state.loadError) {
      return "Could not load EDOPro Rush card IDs from the online XLSX.";
    }

    if (state.missing.length > 0) {
      return `Missing EDOPro card IDs: ${formatYdkeProblemCards(state.missing)}`;
    }

    return "";
  }

  function formatYdkeProblemCards(entries) {
    const names = Array.from(new Set(entries.map((entry) => entry.japaneseName))).slice(0, 6);
    const suffix = entries.length > names.length ? `, and ${entries.length - names.length} more` : "";
    return `${names.join(", ")}${suffix}`;
  }

  function setRelatedStatus(message, isError, retryAction) {
    const relationCard = document.querySelector("#relationCard");
    if (!relationCard) {
      return;
    }

    let status = document.getElementById("rushdb-yugipedia-related-status");
    if (!status) {
      status = document.createElement("div");
      status.id = "rushdb-yugipedia-related-status";
      status.style.cssText = [
        "margin: 8px 0",
        "padding: 6px 8px",
        "border: 1px solid #0f5d8f",
        "background: #eef8ff",
        "color: #10384f",
        "font-size: 12px",
        "line-height: 1.35",
      ].join(";");

      const anchor = relationCard.querySelector(".subcatergory") || relationCard.firstElementChild;
      if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(status, anchor.nextSibling);
      } else {
        relationCard.prepend(status);
      }
    }

    status.style.borderColor = isError ? "#a33" : "#0f5d8f";
    status.style.background = isError ? "#fff0f0" : "#eef8ff";
    status.replaceChildren(document.createTextNode(message));

    if (retryAction) {
      status.appendChild(document.createTextNode(" "));
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = retryAction.retryLabel || "Retry missing cards";
      button.style.cssText = [
        "margin-left: 8px",
        "padding: 2px 8px",
        "border: 1px solid #0f5d8f",
        "border-radius: 3px",
        "background: #fff",
        "color: #10384f",
        "font-size: 12px",
        "line-height: 1.3",
        "cursor: pointer",
      ].join(";");
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.disabled = true;
        try {
          await retryAction();
        } catch (error) {
          console.error("[RushDB Yugipedia English]", error);
          setRelatedStatus("Retry failed against the hosted database and Yugipedia.", true, retryAction);
        }
      });
      status.appendChild(button);
    }
  }

  function getStatusAnchor() {
    if (isDeckPage) {
      return document.querySelector("#mode_set");
    }

    if (isCardListPage) {
      return document.querySelector("#broad_title") || document.querySelector("#mode_set") || document.querySelector(".sort_set");
    }

    if (isLabelOnlyPage) {
      return document.querySelector("#broad_title") || document.querySelector("#form_search") || document.querySelector("#article_body");
    }

    return document.querySelector("#cardname.cardname") || document.querySelector(".sp.cardname");
  }

  function createToggle(enabled) {
    if (document.getElementById("rushdb-yugipedia-english-toggle")) {
      return;
    }

    const wrapper = document.createElement("button");
    wrapper.type = "button";
    wrapper.id = "rushdb-yugipedia-english-toggle";
    wrapper.style.cssText = [
      "display: inline-flex",
      "align-items: center",
      "justify-content: center",
      "gap: 6px",
      "min-width: 112px",
      "min-height: 26px",
      "padding: 0 8px",
      "border: 1px solid #777",
      "border-radius: 4px",
      "background: #fff",
      "color: #222",
      "font-size: 12px",
      "line-height: 1.2",
      "font-family: inherit",
      "white-space: nowrap",
      "cursor: pointer",
      "user-select: none",
    ].join(";");

    let currentEnabled = Boolean(enabled);

    const checkmark = document.createElement("span");
    checkmark.setAttribute("aria-hidden", "true");
    checkmark.style.cssText = [
      "display: inline-flex",
      "align-items: center",
      "justify-content: center",
      "width: 14px",
      "height: 14px",
      "border: 1px solid #3a7ec7",
      "border-radius: 2px",
      "font-size: 12px",
      "line-height: 1",
      "box-sizing: border-box",
      "font-weight: bold",
    ].join(";");

    const setVisualState = (nextEnabled) => {
      currentEnabled = Boolean(nextEnabled);
      wrapper.setAttribute("aria-pressed", currentEnabled ? "true" : "false");
      wrapper.title = currentEnabled ? "Auto English is on" : "Auto English is off";
      checkmark.style.background = currentEnabled ? "#1687d9" : "#fff";
      checkmark.style.color = currentEnabled ? "#fff" : "transparent";
      checkmark.textContent = currentEnabled ? "\u2713" : "";
    };

    wrapper.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const nextEnabled = !currentEnabled;
      wrapper.disabled = true;

      try {
        await setTranslationEnabled(nextEnabled);

        if (nextEnabled) {
          setVisualState(true);
          if (isDeckSearchPage) {
            updateCategorySortToggleAvailability(true, await isCategorySortingEnabled());
          }
          await translateCurrentTarget();
        } else {
          setVisualState(false);
          if (isDeckSearchPage) {
            updateCategorySortToggleAvailability(false, await isCategorySortingEnabled());
            restoreDeckSearchCategoryOrder();
          }
          restoreCurrentTarget();
          setStatus(isLabelOnlyPage ? "English translation is off." : "Yugipedia English translation is off.");
        }
      } catch (error) {
        console.error("[RushDB Yugipedia English]", error);
        setVisualState(await isTranslationEnabled());
        setStatus("Could not change Yugipedia English translation setting.", true);
      } finally {
        wrapper.disabled = false;
      }
    });

    const text = document.createElement("span");
    text.textContent = "Auto English";

    wrapper.append(checkmark, text);
    setVisualState(currentEnabled);

    const deckModeList = document.querySelector("#mode_set.tablink ul");
    if ((isDeckPage || isCardListPage) && deckModeList) {
      const item = document.createElement("li");
      item.className = "rushdb-yugipedia-toggle-item";
      item.style.cursor = "default";
      item.addEventListener("click", (event) => event.stopPropagation());
      wrapper.addEventListener("click", (event) => event.stopPropagation());
      item.appendChild(wrapper);
      deckModeList.appendChild(item);
      return;
    }

    const languageList = document.querySelector(".CardLanguage .item_box_value");
    if (languageList) {
      const item = document.createElement("li");
      item.appendChild(wrapper);
      languageList.appendChild(item);
      return;
    }

    if (isLabelOnlyPage) {
      const anchor = document.querySelector("#broad_title");
      if (anchor && anchor.parentNode) {
        const container = document.createElement("div");
        container.id = "rushdb-yugipedia-deck-search-controls";
        const rect = anchor.getBoundingClientRect();
        container.style.top = `${Math.max(0, rect.bottom + window.scrollY + 4)}px`;
        container.style.left = "0px";
        container.appendChild(wrapper);
        document.body.appendChild(container);
        return;
      }
    }

    const anchor = document.querySelector("#cardname.cardname")
      || document.querySelector(".sp.cardname")
      || document.getElementById("rushdb-yugipedia-english-status");
    if (anchor && anchor.parentNode && anchor.id !== "rushdb-yugipedia-english-status") {
      anchor.parentNode.insertBefore(wrapper, anchor.nextSibling);
    } else {
      document.body.prepend(wrapper);
    }
  }

  function createCategorySortToggle(enabled) {
    if (document.getElementById("rushdb-yugipedia-category-sort-toggle")) {
      return;
    }

    const container = document.getElementById("rushdb-yugipedia-deck-search-controls");
    if (!container) {
      return;
    }

    const wrapper = document.createElement("button");
    wrapper.type = "button";
    wrapper.id = "rushdb-yugipedia-category-sort-toggle";
    wrapper.style.cssText = [
      "display: inline-flex",
      "align-items: center",
      "gap: 6px",
      "min-width: 96px",
      "min-height: 26px",
      "padding: 0 8px",
      "border: 1px solid #777",
      "border-radius: 4px",
      "background: #fff",
      "color: #222",
      "font-size: 12px",
      "line-height: 1.2",
      "font-family: inherit",
      "white-space: nowrap",
      "cursor: pointer",
      "user-select: none",
    ].join(";");

    let currentEnabled = Boolean(enabled);
    const checkmark = document.createElement("span");
    checkmark.setAttribute("aria-hidden", "true");
    checkmark.style.cssText = [
      "display: inline-flex",
      "align-items: center",
      "justify-content: center",
      "width: 14px",
      "height: 14px",
      "border: 1px solid #3a7ec7",
      "border-radius: 2px",
      "font-size: 12px",
      "line-height: 1",
      "box-sizing: border-box",
      "font-weight: bold",
    ].join(";");

    const setVisualState = (nextEnabled) => {
      currentEnabled = Boolean(nextEnabled);
      wrapper.setAttribute("aria-pressed", currentEnabled ? "true" : "false");
      wrapper.title = currentEnabled ? "Registered Categories and Tags are sorted" : "Registered Categories and Tags use original order";
      checkmark.style.background = currentEnabled ? "#1687d9" : "#fff";
      checkmark.style.color = currentEnabled ? "#fff" : "transparent";
      checkmark.textContent = currentEnabled ? "\u2713" : "";
    };

    wrapper.rushdbSetVisualState = setVisualState;

    wrapper.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (wrapper.disabled) {
        return;
      }
      const nextEnabled = !currentEnabled;
      wrapper.disabled = true;

      try {
        await setCategorySortingEnabled(nextEnabled);
        setVisualState(nextEnabled);
        if (nextEnabled) {
          sortDeckSearchCategories();
        } else {
          restoreDeckSearchCategoryOrder();
        }
      } catch (error) {
        console.error("[RushDB Yugipedia English]", error);
        setVisualState(await isCategorySortingEnabled());
        setStatus("Could not change category sorting setting.", true);
      } finally {
        wrapper.disabled = false;
      }
    });

    const text = document.createElement("span");
    text.textContent = "Sort Lists";
    wrapper.append(checkmark, text);
    setVisualState(currentEnabled);
    container.appendChild(wrapper);
  }

  function updateCategorySortToggleAvailability(translationEnabled, sortEnabled) {
    const wrapper = document.getElementById("rushdb-yugipedia-category-sort-toggle");
    if (!wrapper) {
      return;
    }

    if (typeof wrapper.rushdbSetVisualState === "function") {
      wrapper.rushdbSetVisualState(Boolean(sortEnabled));
    }
    wrapper.disabled = !translationEnabled;
    wrapper.setAttribute("aria-disabled", translationEnabled ? "false" : "true");
    wrapper.title = translationEnabled
      ? wrapper.title
      : "Turn on Auto English to use the remembered Sort Lists setting";
  }

  function createDeleteCacheButton() {
    if (document.getElementById("rushdb-yugipedia-delete-cache")) {
      return;
    }

    const container = document.getElementById("rushdb-yugipedia-deck-search-controls");
    if (!container) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.id = "rushdb-yugipedia-delete-cache";
    updateDeleteCacheButton(button);
    button.style.cssText = [
      "display: inline-flex",
      "align-items: center",
      "justify-content: center",
      "min-width: 172px",
      "min-height: 26px",
      "padding: 0 8px",
      "border: 1px solid #777",
      "border-radius: 4px",
      "background: #fff",
      "color: #222",
      "font-size: 12px",
      "line-height: 1.2",
      "font-family: inherit",
      "white-space: nowrap",
      "cursor: pointer",
      "user-select: none",
    ].join(";");

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const deleted = deleteRushDbCache();
      updateDeleteCacheButton(button);
      setStatus(`Deleted ${deleted} cached Auto English ${deleted === 1 ? "entry" : "entries"}.`);
    });

    container.appendChild(button);
  }

  function updateDeleteCacheButton(button) {
    const stats = getRushDbCacheStats();
    button.textContent = `Delete Cache (${formatBytes(stats.bytes)})`;
    button.title = `Delete ${stats.count} cached Auto English ${stats.count === 1 ? "entry" : "entries"} (${formatBytes(stats.bytes)})`;
  }

  function addSearchControlsMinimizeButton(status) {
    if (!isLabelOnlyPage || !status || status.querySelector("#rushdb-yugipedia-minimize-controls")) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.id = "rushdb-yugipedia-minimize-controls";
    button.textContent = "-";
    button.title = "Minimize Auto English controls";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      minimizeSearchControls();
    });
    status.appendChild(button);
  }

  function minimizeSearchControls() {
    const controls = document.getElementById("rushdb-yugipedia-deck-search-controls");
    let restoreTop = 96;
    if (controls) {
      const rect = controls.getBoundingClientRect();
      restoreTop = Math.max(0, Math.round(rect.top + window.scrollY));
      controls.classList.add("rushdb-yugipedia-controls-minimized");
    }
    setSearchControlsMinimized(true);
    showSearchControlsRestoreButton(restoreTop);
  }

  function showSearchControlsRestoreButton(top) {
    if (document.getElementById("rushdb-yugipedia-restore-controls")) {
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.id = "rushdb-yugipedia-restore-controls";
    button.textContent = "+";
    button.title = "Restore Auto English controls";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const controls = document.getElementById("rushdb-yugipedia-deck-search-controls");
      if (controls) {
        controls.classList.remove("rushdb-yugipedia-controls-minimized");
      }
      setSearchControlsMinimized(false);
      button.remove();
    });
    button.style.top = `${Math.max(0, Number(top) || 0)}px`;
    document.body.appendChild(button);
  }

  async function applyStoredSearchControlsMinimizedState() {
    if (!isLabelOnlyPage || !await isSearchControlsMinimized()) {
      return;
    }

    const controls = document.getElementById("rushdb-yugipedia-deck-search-controls");
    let restoreTop = 96;
    if (controls) {
      const rect = controls.getBoundingClientRect();
      restoreTop = Math.max(0, Math.round(rect.top + window.scrollY));
      controls.classList.add("rushdb-yugipedia-controls-minimized");
    }
    showSearchControlsRestoreButton(restoreTop);
  }

  function createVersionNotice() {
    if (document.getElementById("rushdb-yugipedia-version-notice")) {
      return;
    }

    const container = document.getElementById("rushdb-yugipedia-deck-search-controls");
    if (!container) {
      return;
    }

    const notice = document.createElement("a");
    notice.id = "rushdb-yugipedia-version-notice";
    notice.href = RELEASES_PAGE_URL;
    notice.target = "_blank";
    notice.rel = "noopener noreferrer";
    notice.style.display = forceVersionNoticeForTesting() ? "block" : "none";
    notice.textContent = "New Update Available!";
    container.appendChild(notice);

    checkScriptVersion(notice).catch((error) => {
      console.warn("[RushDB Yugipedia English] Version check failed", error);
      if (forceVersionNoticeForTesting()) {
        notice.style.display = "block";
        notice.textContent = "New Update Available!";
      }
    });
  }

  async function checkScriptVersion(notice) {
    const currentVersion = getCurrentScriptVersion();
    const latestVersion = await getLatestReleaseVersion();
    if (!latestVersion) {
      if (forceVersionNoticeForTesting()) {
        notice.style.display = "block";
        notice.textContent = "New Update Available!";
      }
      return;
    }

    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
    if (hasUpdate || forceVersionNoticeForTesting()) {
      notice.style.display = "block";
      notice.textContent = "New Update Available!";
      notice.title = hasUpdate
        ? `Version ${latestVersion} is available. Current version: ${currentVersion}.`
        : `Version notice test mode. Current version: ${currentVersion}; latest version: ${latestVersion}.`;
    } else {
      notice.style.display = "none";
      notice.textContent = "";
    }
  }

  async function getLatestReleaseVersion() {
    const text = await requestText(RELEASES_API_URL, { timeoutMs: 15000 });
    const releases = JSON.parse(text);
    if (!Array.isArray(releases)) {
      return "";
    }

    return releases
      .map((release) => normalizeVersionText(release && (release.tag_name || release.name || "")))
      .filter(Boolean)
      .sort(compareVersions)
      .pop() || "";
  }

  function getCurrentScriptVersion() {
    try {
      if (typeof GM_info !== "undefined" && GM_info && GM_info.script && GM_info.script.version) {
        return normalizeVersionText(GM_info.script.version) || SCRIPT_VERSION;
      }
    } catch (_error) {
      // Fall back to the local constant below.
    }
    return SCRIPT_VERSION;
  }

  function normalizeVersionText(value) {
    const match = String(value || "").trim().match(/v?(\d+(?:\.\d+)*)(?:[-+][0-9A-Za-z.-]+)?/i);
    return match ? match[1] : "";
  }

  function compareVersions(left, right) {
    const leftParts = versionParts(left);
    const rightParts = versionParts(right);
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index += 1) {
      const leftValue = leftParts[index] || 0;
      const rightValue = rightParts[index] || 0;
      if (leftValue !== rightValue) {
        return leftValue > rightValue ? 1 : -1;
      }
    }
    return 0;
  }

  function versionParts(value) {
    return normalizeVersionText(value)
      .split(".")
      .filter((part) => part !== "")
      .map((part) => Number(part) || 0);
  }

  function installToggleStyles() {
    if (document.getElementById("rushdb-yugipedia-english-toggle-style")) {
      return;
    }

    const style = document.createElement("style");
    style.id = "rushdb-yugipedia-english-toggle-style";
    style.textContent = `
      #rushdb-yugipedia-deck-search-controls {
        position: absolute !important;
        z-index: 20 !important;
        display: flex !important;
        flex-wrap: wrap !important;
        align-items: center !important;
        gap: 6px !important;
        width: 392px !important;
        max-width: calc(100vw - 12px) !important;
        margin: 0 !important;
        pointer-events: none !important;
      }

      #rushdb-yugipedia-deck-search-controls.rushdb-yugipedia-controls-minimized {
        display: none !important;
      }

      #rushdb-yugipedia-deck-search-controls #rushdb-yugipedia-english-status {
        display: inline-flex !important;
        align-items: center !important;
        gap: 6px !important;
        flex: 0 0 100% !important;
        flex-basis: 100% !important;
        width: 100% !important;
        max-width: 100% !important;
        min-height: 26px !important;
        box-sizing: border-box !important;
        margin: 0 !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        pointer-events: auto !important;
      }

      #rushdb-yugipedia-deck-search-controls #rushdb-yugipedia-english-status .rushdb-yugipedia-status-message {
        flex: 1 1 auto !important;
        min-width: 0 !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }

      #rushdb-yugipedia-minimize-controls {
        flex: 0 0 22px !important;
        width: 22px !important;
        min-width: 22px !important;
        height: 20px !important;
        padding: 0 !important;
        border: 1px solid #0f5d8f !important;
        border-radius: 3px !important;
        background: #ffffff !important;
        color: #10384f !important;
        font-size: 14px !important;
        font-weight: bold !important;
        line-height: 18px !important;
        text-align: center !important;
        cursor: pointer !important;
      }

      #rushdb-yugipedia-restore-controls {
        position: absolute !important;
        left: 0 !important;
        z-index: 9999 !important;
        width: 28px !important;
        height: 28px !important;
        padding: 0 !important;
        border: 1px solid #0f5d8f !important;
        border-left: 0 !important;
        border-radius: 0 4px 4px 0 !important;
        background: #eef8ff !important;
        color: #10384f !important;
        font-size: 18px !important;
        font-weight: bold !important;
        line-height: 26px !important;
        text-align: center !important;
        cursor: pointer !important;
      }

      #rushdb-yugipedia-deck-search-controls #rushdb-yugipedia-english-status + #rushdb-yugipedia-english-toggle {
        margin-left: 0 !important;
      }

      #rushdb-yugipedia-deck-search-controls #rushdb-yugipedia-english-status {
        order: 0 !important;
      }

      #rushdb-yugipedia-deck-search-controls #rushdb-yugipedia-version-notice {
        order: 2 !important;
        flex: 0 0 100% !important;
        width: 100% !important;
        max-width: 100% !important;
        min-height: 22px !important;
        box-sizing: border-box !important;
        padding: 3px 6px !important;
        border: 1px solid #b57800 !important;
        border-radius: 3px !important;
        background: #fff8e1 !important;
        color: #5f3b00 !important;
        font-size: 12px !important;
        font-weight: bold !important;
        line-height: 1.25 !important;
        text-align: center !important;
        text-decoration: underline !important;
        white-space: normal !important;
        pointer-events: auto !important;
      }

      #rushdb-yugipedia-deck-search-controls #rushdb-yugipedia-english-toggle,
      #rushdb-yugipedia-deck-search-controls #rushdb-yugipedia-category-sort-toggle,
      #rushdb-yugipedia-deck-search-controls #rushdb-yugipedia-delete-cache {
        order: 1 !important;
        flex: 0 0 auto !important;
        box-sizing: border-box !important;
        pointer-events: auto !important;
      }

      #rushdb-yugipedia-deck-search-controls #rushdb-yugipedia-english-toggle {
        width: 112px !important;
        min-width: 112px !important;
        white-space: nowrap !important;
      }

      #rushdb-yugipedia-deck-search-controls #rushdb-yugipedia-category-sort-toggle {
        width: 96px !important;
        min-width: 96px !important;
        white-space: nowrap !important;
      }

      #rushdb-yugipedia-deck-search-controls #rushdb-yugipedia-delete-cache {
        width: 172px !important;
        min-width: 172px !important;
        white-space: nowrap !important;
      }

      #rushdb-yugipedia-english-toggle,
      #rushdb-yugipedia-english-toggle:hover,
      #rushdb-yugipedia-english-toggle:focus,
      #rushdb-yugipedia-english-toggle:active,
      #rushdb-yugipedia-category-sort-toggle,
      #rushdb-yugipedia-category-sort-toggle:hover,
      #rushdb-yugipedia-category-sort-toggle:focus,
      #rushdb-yugipedia-category-sort-toggle:active,
      #rushdb-yugipedia-delete-cache,
      #rushdb-yugipedia-delete-cache:hover,
      #rushdb-yugipedia-delete-cache:focus,
      #rushdb-yugipedia-delete-cache:active {
        background: #ffffff !important;
        color: #111111 !important;
        border-color: #777777 !important;
        opacity: 1 !important;
        text-shadow: none !important;
      }

      #rushdb-yugipedia-english-toggle[aria-pressed="true"] > span:first-child,
      #rushdb-yugipedia-english-toggle[aria-pressed="true"]:hover > span:first-child,
      #rushdb-yugipedia-english-toggle[aria-pressed="true"]:focus > span:first-child,
      #rushdb-yugipedia-english-toggle[aria-pressed="true"]:active > span:first-child,
      #rushdb-yugipedia-category-sort-toggle[aria-pressed="true"] > span:first-child,
      #rushdb-yugipedia-category-sort-toggle[aria-pressed="true"]:hover > span:first-child,
      #rushdb-yugipedia-category-sort-toggle[aria-pressed="true"]:focus > span:first-child,
      #rushdb-yugipedia-category-sort-toggle[aria-pressed="true"]:active > span:first-child {
        background: #1687d9 !important;
        color: #ffffff !important;
        border-color: #3a7ec7 !important;
      }

      #rushdb-yugipedia-english-toggle[aria-pressed="false"] > span:first-child,
      #rushdb-yugipedia-english-toggle[aria-pressed="false"]:hover > span:first-child,
      #rushdb-yugipedia-english-toggle[aria-pressed="false"]:focus > span:first-child,
      #rushdb-yugipedia-english-toggle[aria-pressed="false"]:active > span:first-child,
      #rushdb-yugipedia-category-sort-toggle[aria-pressed="false"] > span:first-child,
      #rushdb-yugipedia-category-sort-toggle[aria-pressed="false"]:hover > span:first-child,
      #rushdb-yugipedia-category-sort-toggle[aria-pressed="false"]:focus > span:first-child,
      #rushdb-yugipedia-category-sort-toggle[aria-pressed="false"]:active > span:first-child {
        background: #ffffff !important;
        color: transparent !important;
        border-color: #3a7ec7 !important;
      }

      #rushdb-yugipedia-english-toggle > span:not(:first-child),
      #rushdb-yugipedia-english-toggle:hover > span:not(:first-child),
      #rushdb-yugipedia-english-toggle:focus > span:not(:first-child),
      #rushdb-yugipedia-english-toggle:active > span:not(:first-child),
      #rushdb-yugipedia-category-sort-toggle > span:not(:first-child),
      #rushdb-yugipedia-category-sort-toggle:hover > span:not(:first-child),
      #rushdb-yugipedia-category-sort-toggle:focus > span:not(:first-child),
      #rushdb-yugipedia-category-sort-toggle:active > span:not(:first-child),
      #rushdb-yugipedia-delete-cache {
        color: #111111 !important;
        display: inline !important;
        opacity: 1 !important;
        text-shadow: none !important;
        visibility: visible !important;
      }

      #rushdb-yugipedia-category-sort-toggle:disabled,
      #rushdb-yugipedia-category-sort-toggle:disabled:hover,
      #rushdb-yugipedia-category-sort-toggle:disabled:focus,
      #rushdb-yugipedia-category-sort-toggle:disabled:active {
        cursor: not-allowed !important;
        opacity: 0.55 !important;
      }

      #mode_set .rushdb-yugipedia-toggle-item,
      #mode_set .rushdb-yugipedia-toggle-item:hover,
      #mode_set .rushdb-yugipedia-toggle-item.now {
        background: transparent !important;
        border-color: transparent !important;
        cursor: default !important;
        overflow: visible !important;
        width: auto !important;
        min-width: 125px !important;
      }

      #update_list .rushdb-yugipedia-set-code {
        display: inline-block !important;
        margin-right: 14px !important;
        white-space: nowrap !important;
      }

      #update_list .rushdb-yugipedia-pack-name {
        display: inline-block !important;
        padding-left: 14px !important;
        border-left: 1px solid rgba(255, 255, 255, 0.35) !important;
        vertical-align: middle !important;
      }
    `;

    document.head.appendChild(style);
  }

  async function isTranslationEnabled() {
    const value = await getStoredValue(ENABLED_KEY, "1");
    return value !== "0";
  }

  async function setTranslationEnabled(enabled) {
    await setStoredValue(ENABLED_KEY, enabled ? "1" : "0");
  }

  async function isCategorySortingEnabled() {
    const value = await getStoredValue(SORT_CATEGORIES_KEY, "1");
    return value !== "0";
  }

  async function setCategorySortingEnabled(enabled) {
    await setStoredValue(SORT_CATEGORIES_KEY, enabled ? "1" : "0");
  }

  async function isSearchControlsMinimized() {
    const value = await getStoredValue(CONTROLS_MINIMIZED_KEY, "0");
    return value === "1";
  }

  function setSearchControlsMinimized(minimized) {
    setStoredValue(CONTROLS_MINIMIZED_KEY, minimized ? "1" : "0").catch((error) => {
      console.warn("[RushDB Yugipedia English] Could not save minimized controls state", error);
    });
  }

  async function getStoredValue(key, defaultValue) {
    const values = [];

    try {
      if (typeof GM !== "undefined" && GM.getValue) {
        const value = await GM.getValue(key);
        if (value !== undefined && value !== null) {
          values.push(String(value));
        }
      }
    } catch (_error) {
      // Try the next storage API.
    }

    try {
      if (typeof GM_getValue !== "undefined") {
        const value = GM_getValue(key);
        if (value !== undefined && value !== null) {
          values.push(String(value));
        }
      }
    } catch (_error) {
      // Try page storage.
    }

    try {
      const value = localStorage.getItem(key);
      if (value !== null) {
        values.push(String(value));
      }
    } catch (_error) {
      // Page storage can be blocked.
    }

    if (values.includes("0")) {
      return "0";
    }
    if (values.includes("1")) {
      return "1";
    }

    return defaultValue;
  }

  async function setStoredValue(key, value) {
    let wrote = false;

    try {
      if (typeof GM !== "undefined" && GM.setValue) {
        await GM.setValue(key, value);
        wrote = true;
      }
    } catch (_error) {
      // Try the next storage API.
    }

    try {
      if (typeof GM_setValue !== "undefined") {
        GM_setValue(key, value);
        wrote = true;
      }
    } catch (_error) {
      // Try page storage.
    }

    try {
      localStorage.setItem(key, value);
      wrote = true;
    } catch (_error) {
      // Page storage can be blocked.
    }

    if (!wrote) {
      throw new Error("No storage API was available for the Auto English setting.");
    }
  }

  function readCache(databaseId) {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + databaseId);
      if (!raw) {
        return null;
      }

      const cached = JSON.parse(raw);
      if (!cached || !cached.savedAt || Date.now() - cached.savedAt > CACHE_TTL_MS) {
        localStorage.removeItem(CACHE_PREFIX + databaseId);
        return null;
      }

      return cached.card || null;
    } catch (_error) {
      return null;
    }
  }

  function writeCache(databaseId, card) {
    try {
      localStorage.setItem(CACHE_PREFIX + databaseId, JSON.stringify({
        savedAt: Date.now(),
        card,
      }));
      pruneCardCache();
    } catch (_error) {
      // localStorage can be unavailable or full; the script still works without cache.
    }
  }

  function deleteRushDbCache() {
    hostedDatabasePromise = null;
    let deleted = 0;

    try {
      const keys = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (isRushDbCacheEntryKey(key)) {
          keys.push(key);
        }
      }

      keys.forEach((key) => {
        localStorage.removeItem(key);
        deleted += 1;
      });
    } catch (_error) {
      // Cache deletion is best-effort; a browser/storage policy can block localStorage.
    }

    return deleted;
  }

  function getRushDbCacheStats() {
    const stats = { count: 0, bytes: 0 };

    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!isRushDbCacheEntryKey(key)) {
          continue;
        }

        const value = localStorage.getItem(key) || "";
        stats.count += 1;
        stats.bytes += estimateStorageBytes(key) + estimateStorageBytes(value);
      }
    } catch (_error) {
      // Storage can be blocked; show zero rather than failing page translation.
    }

    return stats;
  }

  function estimateStorageBytes(value) {
    return String(value || "").length * 2;
  }

  function isRushDbCacheEntryKey(key) {
    if (!key || !key.startsWith(CACHE_PREFIX)) {
      return false;
    }
    return key !== ENABLED_KEY && key !== SORT_CATEGORIES_KEY && key !== CONTROLS_MINIMIZED_KEY;
  }

  function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) {
      return `${value} B`;
    }
    if (value < 1024 * 1024) {
      return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
    }
    return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function pruneCardCache() {
    try {
      const entries = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key || !key.startsWith(CACHE_PREFIX)) {
          continue;
        }

        const suffix = key.slice(CACHE_PREFIX.length);
        if (!/^\d+$/.test(suffix)) {
          continue;
        }

        let savedAt = 0;
        try {
          const cached = JSON.parse(localStorage.getItem(key) || "{}");
          savedAt = Number(cached.savedAt) || 0;
        } catch (_error) {
          savedAt = 0;
        }
        entries.push({ key, savedAt });
      }

      if (entries.length <= CACHE_MAX_CARDS) {
        return;
      }

      entries
        .sort((a, b) => a.savedAt - b.savedAt)
        .slice(0, entries.length - CACHE_MAX_CARDS)
        .forEach((entry) => localStorage.removeItem(entry.key));
    } catch (_error) {
      // Cache pruning is best-effort.
    }
  }
})();
