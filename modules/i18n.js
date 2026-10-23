"use strict";

// Thin wrapper around browser.i18n so the rest of the add-on never touches the
// raw API. The UI locale follows Thunderbird's language; the classification
// prompt language is configured separately (see modules/promptLanguage.js).

const NAMED_PLACEHOLDER = /\$([A-Za-z_][A-Za-z0-9_]*)\$/g;

/**
 * Translate a message key. Falls back to the key itself so a missing
 * translation is visible instead of silently blank.
 */
export function t(key, subs = null) {
    let message = '';
    try {
        message = browser.i18n.getMessage(key, Array.isArray(subs) ? subs : null) || '';
    } catch (e) {
        message = '';
    }
    if (!message) return key;
    if (!subs || Array.isArray(subs)) return message;
    return message.replace(NAMED_PLACEHOLDER, (match, name) => {
        const value = subs[name];
        return value === undefined || value === null ? match : String(value);
    });
}

/** The locale Thunderbird is running in, e.g. "zh-CN". */
export function currentLocale() {
    try {
        return browser.i18n.getUILanguage() || 'en-US';
    } catch (e) {
        return 'en-US';
    }
}

/**
 * Replace marked-up text and attributes in a document.
 * Supported markers: data-i18n, data-i18n-title, data-i18n-placeholder,
 * data-i18n-alt, data-i18n-aria-label.
 */
export function applyToDocument(root = null) {
    const scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelectorAll !== 'function') return;
    for (const el of scope.querySelectorAll('[data-i18n]')) {
        el.textContent = t(el.dataset.i18n);
    }
    for (const el of scope.querySelectorAll('[data-i18n-title]')) {
        el.title = t(el.dataset.i18nTitle);
    }
    for (const el of scope.querySelectorAll('[data-i18n-placeholder]')) {
        el.placeholder = t(el.dataset.i18nPlaceholder);
    }
    for (const el of scope.querySelectorAll('[data-i18n-alt]')) {
        el.alt = t(el.dataset.i18nAlt);
    }
    for (const el of scope.querySelectorAll('[data-i18n-aria-label]')) {
        el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
    }
}
