import { readFile } from 'node:fs/promises';

/** Load a raw message catalog from _locales. */
export async function loadMessages(locale = 'en-US') {
    const raw = await readFile(new URL(`../../_locales/${locale}/messages.json`, import.meta.url), 'utf8');
    return JSON.parse(raw);
}

/**
 * A `t()` implementation backed by a real message catalog, so tests exercise
 * the shipped translations instead of a stub.
 */
export function translatorFor(messages) {
    return function t(key, subs = null) {
        const message = messages[key]?.message || '';
        if (!message) return key;
        if (!subs) return message;
        return message.replace(/\$([A-Za-z_][A-Za-z0-9_]*)\$/g, (match, name) => {
            const value = subs[name];
            return value === undefined || value === null ? match : String(value);
        });
    };
}

/** Every `$NAME$` placeholder used by a message, in order of appearance. */
export function placeholdersOf(message) {
    return [...String(message).matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\$/g)].map(m => m[1]);
}
